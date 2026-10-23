import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler, badRequest, forbidden, notFound, parse } from '../errors.js';
import { getDb, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';

export const filesRouter = Router();
filesRouter.use(requireAuth);

/**
 * Two storage modes.
 *
 * - `disk` (default, local development): files live under UPLOAD_DIR.
 * - `db` (FILE_STORAGE=db, used on Render's free service): the bytes live in
 *   `files.data` because the free instance has no persistent disk. The
 *   permission checks are identical in both modes.
 */
const useDbStorage = config.fileStorage === 'db';

if (!useDbStorage) fs.mkdirSync(config.uploadDir, { recursive: true });

const ALLOWED = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

function storedName(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  return `${crypto.randomUUID()}${ext || '.bin'}`;
}

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadDir),
  filename: (_req, file, cb) => cb(null, storedName(file.originalname)),
});

const upload = multer({
  storage: useDbStorage ? multer.memoryStorage() : diskStorage,
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      cb(new Error('Unsupported file type. Upload an image, PDF or MP4/WebM video.'));
      return;
    }
    cb(null, true);
  },
});

function discardTempFile(file: Express.Multer.File | undefined): void {
  if (!file?.path) return;
  fs.unlink(file.path, () => undefined);
}

filesRouter.post(
  '/files',
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
          ? `File is larger than ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`
          : (err as Error).message;
        res.status(400).json({ error: { code: 'upload_failed', message } });
        return;
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Choose a file to upload');
    const purpose = parse(
      z.enum(['pet_photo', 'record', 'chat', 'avatar', 'credential']),
      req.body.purpose ?? 'record',
    );
    const petId = typeof req.body.petId === 'string' && req.body.petId ? req.body.petId : null;
    if (petId) {
      const pet = await one<{ owner_id: string }>('SELECT owner_id FROM pets WHERE id = $1', [petId]);
      if (!pet || (pet.owner_id !== req.user!.id && req.user!.role !== 'admin')) {
        discardTempFile(req.file);
        throw forbidden('You cannot attach a file to this pet');
      }
    }
    const fileId = crypto.randomUUID();
    const name = useDbStorage ? storedName(req.file.originalname) : req.file.filename;
    const data = useDbStorage ? req.file.buffer : null;
    await (await getDb()).query(
      `INSERT INTO files (id, owner_id, pet_id, original_name, stored_name, mime, size, purpose, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        fileId, req.user!.id, petId, req.file.originalname.slice(0, 240), name,
        req.file.mimetype, req.file.size, purpose, data,
      ],
    );
    res.status(201).json({
      file: {
        id: fileId,
        originalName: req.file.originalname,
        mime: req.file.mimetype,
        size: req.file.size,
        purpose,
        url: `/api/files/${fileId}`,
      },
    });
  }),
);

filesRouter.get(
  '/files/:id',
  asyncHandler(async (req, res) => {
    const file = await one<{
      id: string; owner_id: string; pet_id: string | null; stored_name: string; mime: string;
      original_name: string; purpose: string; data: Buffer | null;
    }>(
      `SELECT id, owner_id, pet_id, stored_name, mime, original_name, purpose, data
       FROM files WHERE id = $1`,
      [req.params.id],
    );
    if (!file) throw notFound('File not found');

    const user = req.user!;
    let allowed = user.role === 'admin' || file.owner_id === user.id;

    if (!allowed && file.purpose === 'credential') allowed = false;
    if (!allowed && file.pet_id) {
      const pet = await one<{ owner_id: string }>('SELECT owner_id FROM pets WHERE id = $1', [file.pet_id]);
      if (pet?.owner_id === user.id) allowed = true;
      if (!allowed && user.role === 'vet') {
        const shared = await one(
          `SELECT 1 AS ok FROM appointments WHERE pet_id = $1 AND vet_id = $2 AND status IN ('accepted','completed') LIMIT 1`,
          [file.pet_id, user.id],
        );
        if (shared) allowed = true;
      }
    }
    if (!allowed && user.role === 'vet') {
      const chat = await one(
        `SELECT 1 AS ok FROM messages m JOIN threads t ON t.id = m.thread_id
         WHERE m.file_id = $1 AND t.vet_id = $2 LIMIT 1`,
        [file.id, user.id],
      );
      if (chat) allowed = true;
    }
    if (!allowed && user.role === 'owner') {
      const chat = await one(
        `SELECT 1 AS ok FROM messages m JOIN threads t ON t.id = m.thread_id
         WHERE m.file_id = $1 AND t.owner_id = $2 LIMIT 1`,
        [file.id, user.id],
      );
      if (chat) allowed = true;
    }
    if (!allowed) throw forbidden('You do not have access to this file');

    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${file.original_name.replace(/["\\]/g, '')}"`,
    );

    // Rows uploaded before FILE_STORAGE=db have no bytes in the database; they
    // still resolve from disk in development.
    //
    // A bytea column comes back as Buffer (pg) or Uint8Array (PGlite). Sending
    // a Uint8Array through res.send() would JSON-serialise it, so normalise to
    // a Buffer and end the response with the raw bytes.
    if (file.data && file.data.length) {
      const bytes = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
      res.setHeader('Content-Length', String(bytes.length));
      res.end(bytes);
      return;
    }
    const full = path.join(config.uploadDir, file.stored_name);
    if (!fs.existsSync(full)) throw notFound('Stored file is missing');
    res.sendFile(full);
  }),
);

filesRouter.delete(
  '/files/:id',
  asyncHandler(async (req, res) => {
    const file = await one<{ owner_id: string; stored_name: string; data: Buffer | null }>(
      'SELECT owner_id, stored_name, data FROM files WHERE id = $1',
      [req.params.id],
    );
    if (!file) throw notFound('File not found');
    if (file.owner_id !== req.user!.id && req.user!.role !== 'admin') throw forbidden();
    await (await getDb()).query('DELETE FROM files WHERE id = $1', [req.params.id]);
    if (!file.data) fs.unlink(path.join(config.uploadDir, file.stored_name), () => undefined);
    res.status(204).send();
  }),
);
