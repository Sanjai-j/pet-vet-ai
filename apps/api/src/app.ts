import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config, ROOT } from './config.js';
import { getDb, one } from './db.js';
import { errorMiddleware } from './errors.js';
import { authRouter } from './routes/auth.js';
import { catalogRouter } from './routes/catalog.js';
import { petsRouter } from './routes/pets.js';
import { careRouter } from './routes/care.js';
import { dashboardRouter } from './routes/dashboard.js';
import { aiRouter } from './routes/ai.js';
import { providersRouter } from './routes/providers.js';
import { appointmentsRouter } from './routes/appointments.js';
import { threadsRouter } from './routes/threads.js';
import { vetRouter } from './routes/vet.js';
import { filesRouter } from './routes/files.js';
import { notificationsRouter } from './routes/notifications.js';
import { adminRouter } from './routes/admin.js';
import { reportsRouter } from './routes/reports.js';
import { mapsRouter } from './routes/maps.js';
import { directoryRouter } from './routes/directory.js';
import { slotsRouter } from './routes/slots.js';
import { nutritionRouter, nutritionAdminRouter } from './routes/nutrition.js';
import { vaccinationPlanRouter } from './routes/vaccination-plan.js';
import { aiRuntimeInfo } from './services/ai.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: config.isProd ? undefined : false,
    }),
  );
  const allowedOrigins = new Set([
    config.webOrigin,
    'http://localhost:4200',
    'http://127.0.0.1:4200',
    `http://localhost:${config.port}`,
  ]);
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || allowedOrigins.has(origin)) return cb(null, true);
        cb(null, false);
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (_req, res) => {
    let dbOk = false;
    try {
      const db = await getDb();
      await db.query('SELECT 1');
      dbOk = true;
    } catch {
      dbOk = false;
    }
    // Configuration alone cannot explain a deterministic reply: the admin
    // switch in the database can silence a perfectly configured model. Report
    // it next to the configuration so the two are never confused again.
    let llmEnabledByAdmin: boolean | null = null;
    try {
      const row = await one<{ value: { llmEnabled?: boolean } }>(
        `SELECT value FROM settings WHERE key = 'ai'`,
      );
      llmEnabledByAdmin = row ? row.value?.llmEnabled !== false : null;
    } catch {
      llmEnabledByAdmin = null;
    }
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      database: dbOk ? 'ok' : 'unavailable',
      ai: { ...aiRuntimeInfo(), llmEnabledByAdmin },
      timezone: config.timezone,
      time: new Date().toISOString(),
      version: '1.0.0',
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api', catalogRouter);
  // Public discovery/config routes must be mounted before any router that
  // applies requireAuth at the router level.
  app.use('/api', providersRouter);
  app.use('/api/pets', petsRouter);
  app.use('/api', careRouter);
  app.use('/api', dashboardRouter);
  app.use('/api', aiRouter);
  app.use('/api', appointmentsRouter);
  app.use('/api', threadsRouter);
  // Mounted on its own prefix: this router applies requireVet to every request,
  // so it must not sit at /api ahead of other routes.
  app.use('/api/vet', vetRouter);
  app.use('/api', filesRouter);
  app.use('/api', notificationsRouter);
  app.use('/api', mapsRouter);
  app.use('/api', directoryRouter);
  // Slots router must precede the vetRouter mount so its /vet/slots paths
  // are matched before vetRouter's catch-all /api/vet prefix.
  app.use('/api', slotsRouter);
  app.use('/api', nutritionRouter);
  app.use('/api', vaccinationPlanRouter);
  app.use('/api', nutritionAdminRouter);
  app.use('/api', adminRouter);
  app.use('/api', reportsRouter);

  const webDist = path.join(ROOT, 'apps', 'web', 'dist', 'pet-vet-ai', 'browser');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/|\/ws).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
    console.log(`[web] serving built Angular app from ${webDist}`);
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'API endpoint not found' } });
  });

  app.use(errorMiddleware);
  return app;
}
