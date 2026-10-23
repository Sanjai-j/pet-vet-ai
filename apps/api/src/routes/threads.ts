import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, forbidden, notFound, parse } from '../errors.js';
import { getDb, many, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { assertPetOwner } from '../access.js';

export const threadsRouter = Router();
threadsRouter.use(requireAuth);

const threadSelect = `
  SELECT t.id, t.owner_id AS "ownerId", t.vet_id AS "vetId", t.pet_id AS "petId",
         t.appointment_id AS "appointmentId",
         t.created_at AS "createdAt", t.last_message_at AS "lastMessageAt",
         p.name AS "petName", p.species_code AS "petSpecies",
         owner.full_name AS "ownerName", vet.full_name AS "vetName",
         vp.clinic_name AS "clinicName",
         (SELECT m.body FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS "lastMessage",
         (SELECT count(*)::int FROM messages m WHERE m.thread_id = t.id AND m.sender_id <> $1 AND m.read_at IS NULL) AS "unread"
  FROM threads t
  JOIN pets p ON p.id = t.pet_id
  JOIN users owner ON owner.id = t.owner_id
  JOIN users vet ON vet.id = t.vet_id
  LEFT JOIN vet_profiles vp ON vp.user_id = t.vet_id
`;

async function loadThread(threadId: string, userId: string, role: string) {
  const thread = await one<Record<string, any>>(`${threadSelect} WHERE t.id = $2`, [userId, threadId]);
  if (!thread) throw notFound('Conversation not found');
  if (role !== 'admin' && thread.ownerId !== userId && thread.vetId !== userId) {
    throw forbidden('You are not part of this conversation');
  }
  return thread;
}

threadsRouter.get(
  '/threads',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    let where = 't.owner_id = $1';
    if (user.role === 'vet') where = 't.vet_id = $1';
    if (user.role === 'admin') where = '1 = 1';
    const rows = await many(
      `${threadSelect} WHERE ${where} ORDER BY COALESCE(t.last_message_at, t.created_at) DESC`,
      [user.id],
    );
    res.json({ threads: rows });
  }),
);

threadsRouter.post(
  '/threads',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    if (user.role !== 'owner') throw forbidden('Only pet owners can start a conversation');
    const body = parse(
      z.object({ vetId: z.string().min(1), petId: z.string().min(1) }),
      req.body,
    );
    const pet = await assertPetOwner(body.petId, user);
    const vet = await one<{ userId: string; verified: string; species: string[] }>(
      `SELECT v.user_id AS "userId", v.verification_status AS verified, v.species
       FROM vet_profiles v JOIN users u ON u.id = v.user_id
       WHERE v.user_id = $1 AND u.disabled = false`,
      [body.vetId],
    );
    if (!vet) throw notFound('Veterinarian not found');
    if (vet.verified !== 'verified') throw badRequest('Messaging is available after a veterinarian is verified');
    if (!vet.species.includes(pet.speciesCode)) {
      throw badRequest('This veterinarian does not list your pet’s species');
    }
    const db = await getDb();
    const existing = await one<{ id: string }>(
      'SELECT id FROM threads WHERE owner_id = $1 AND vet_id = $2 AND pet_id = $3',
      [user.id, body.vetId, pet.id],
    );
    const threadId = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      await db.query(
        `INSERT INTO threads (id, owner_id, vet_id, pet_id) VALUES ($1,$2,$3,$4)`,
        [threadId, user.id, body.vetId, pet.id],
      );
    }
    res.status(201).json({ thread: await one(`${threadSelect} WHERE t.id = $2`, [user.id, threadId]) });
  }),
);

threadsRouter.get(
  '/threads/:id',
  asyncHandler(async (req, res) => {
    const thread = await loadThread(req.params.id, req.user!.id, req.user!.role);
    const messages = await many(
      `SELECT m.id, m.sender_id AS "senderId", m.body, m.file_id AS "fileId",
              m.read_at AS "readAt", m.created_at AS "createdAt", u.full_name AS "senderName",
              f.original_name AS "fileName", f.mime AS "fileMime"
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN files f ON f.id = m.file_id
       WHERE m.thread_id = $1 ORDER BY m.created_at`,
      [thread.id],
    );
    res.json({ thread, messages });
  }),
);

threadsRouter.post(
  '/threads/:id/messages',
  asyncHandler(async (req, res) => {
    const thread = await loadThread(req.params.id, req.user!.id, req.user!.role);
    const body = parse(
      z.object({
        body: z.string().max(4000).default(''),
        fileId: z.string().max(80).optional(),
      }),
      req.body,
    );
    const text = (body.body ?? '').trim();
    if (!text && !body.fileId) throw badRequest('Write a message or attach a file');
    if (body.fileId) {
      const file = await one<{ owner_id: string }>('SELECT owner_id FROM files WHERE id = $1', [body.fileId]);
      if (!file || (file.owner_id !== req.user!.id && req.user!.role !== 'admin')) {
        throw badRequest('Attachment not found');
      }
    }
    const id = crypto.randomUUID();
    await (await getDb()).query(
      `INSERT INTO messages (id, thread_id, sender_id, body, file_id) VALUES ($1,$2,$3,$4,$5)`,
      [id, thread.id, req.user!.id, text || 'Attachment', body.fileId ?? null],
    );
    await (await getDb()).query('UPDATE threads SET last_message_at = now() WHERE id = $1', [thread.id]);
    res.status(201).json({ message: await one('SELECT * FROM messages WHERE id = $1', [id]) });
  }),
);
