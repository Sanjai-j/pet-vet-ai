import http from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';
import { closeDb } from './db.js';
import { attachWebSocket, closeWebSocket } from './ws.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';

async function main() {
  await migrate();
  if (config.seedCatalog) await seed();

  const app = createApp();
  const server = http.createServer(app);
  attachWebSocket(server);

  server.listen(config.port, () => {
    console.log(`[api] Pet Vet AI API listening on http://localhost:${config.port}`);
    console.log(`[api] health: http://localhost:${config.port}/api/health`);
    console.log(`[api] AI mode: ${config.llm.provider === 'none' || !config.llm.apiKey ? 'deterministic demo (no LLM key)' : `LLM (${config.llm.model})`}`);
    startScheduler();
  });

  const shutdown = (signal: string) => {
    console.log(`[api] ${signal} received, shutting down`);
    stopScheduler();
    closeWebSocket();
    server.close(() => {
      closeDb().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[api] failed to start', err);
  process.exit(1);
});
