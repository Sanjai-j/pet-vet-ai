import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import { getDb } from './db.js';
import { createNotification, notificationEvents } from './services/notifications.js';

interface SocketMeta {
  userId: string;
  socket: WebSocket;
  alive: boolean;
}

const clients = new Map<string, Set<WebSocket>>();
let wss: WebSocketServer | null = null;

/** Origins allowed to open a socket. Mirrors the HTTP CORS list. */
function allowedOrigins(): Set<string> {
  return new Set(
    [
      config.webOrigin,
      'http://localhost:4200',
      'http://127.0.0.1:4200',
      `http://localhost:${config.port}`,
      `http://127.0.0.1:${config.port}`,
    ].filter(Boolean),
  );
}

/**
 * A browser always sends Origin on a WebSocket handshake, so a mismatch means
 * the request came from another site (cross-site socket hijacking). Non-browser
 * clients (tests, scripts) usually omit it; those are allowed through and still
 * need a valid token.
 */
export function isAllowedSocketOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return allowedOrigins().has(origin);
}

function register(userId: string, socket: WebSocket): void {
  const set = clients.get(userId) ?? new Set();
  set.add(socket);
  clients.set(userId, set);
}

function unregister(userId: string, socket: WebSocket): void {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(socket);
  if (!set.size) clients.delete(userId);
}

export function sendToUser(userId: string, payload: unknown): void {
  const set = clients.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const socket of set) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
}

notificationEvents.on('notification', ({ userId, notification }) => {
  sendToUser(userId, { type: 'notification', notification });
});

async function handleMessage(userId: string, socket: WebSocket, raw: string): Promise<void> {
  let msg: Record<string, any>;
  try {
    msg = JSON.parse(raw);
  } catch {
    socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON frame' }));
    return;
  }

  const db = await getDb();

  if (msg.type === 'ping') {
    socket.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  if (msg.type === 'chat') {
    const threadId = String(msg.threadId ?? '');
    const body = String(msg.body ?? '').trim();
    if (!threadId || (!body && !msg.fileId)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Message cannot be empty' }));
      return;
    }
    if (body.length > 4000) {
      socket.send(JSON.stringify({ type: 'error', message: 'Message is too long' }));
      return;
    }
    const threads = await db.query<{ id: string; owner_id: string; vet_id: string }>(
      'SELECT id, owner_id, vet_id FROM threads WHERE id = $1',
      [threadId],
    );
    const thread = threads[0];
    if (!thread || ![thread.owner_id, thread.vet_id].includes(userId)) {
      socket.send(JSON.stringify({ type: 'error', message: 'You are not part of this conversation' }));
      return;
    }
    let fileId: string | null = null;
    if (msg.fileId) {
      const files = await db.query<{ id: string; owner_id: string }>('SELECT id, owner_id FROM files WHERE id = $1', [String(msg.fileId)]);
      if (!files[0] || files[0].owner_id !== userId) {
        socket.send(JSON.stringify({ type: 'error', message: 'Attachment not found' }));
        return;
      }
      fileId = files[0].id;
    }
    const messageId = crypto.randomUUID();
    await db.query(
      `INSERT INTO messages (id, thread_id, sender_id, body, file_id) VALUES ($1, $2, $3, $4, $5)`,
      [messageId, threadId, userId, body || 'Attachment', fileId],
    );
    await db.query('UPDATE threads SET last_message_at = now() WHERE id = $1', [threadId]);
    const rows = await db.query(
      `SELECT m.id, m.thread_id AS "threadId", m.sender_id AS "senderId", m.body,
              m.file_id AS "fileId", m.created_at AS "createdAt", u.full_name AS "senderName"
       FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`,
      [messageId],
    );
    const message = rows[0];
    const recipient = thread.owner_id === userId ? thread.vet_id : thread.owner_id;
    for (const participant of new Set([thread.owner_id, thread.vet_id])) {
      sendToUser(participant, { type: 'message', message });
    }
    if (recipient !== userId) {
      await createNotification({
        userId: recipient,
        title: `New message from ${message.senderName}`,
        body: body.slice(0, 140) || 'Sent an attachment',
        kind: 'message',
        link: '/messages',
      });
    }
    return;
  }

  if (msg.type === 'typing') {
    const db2 = await getDb();
    const rows = await db2.query<{ owner_id: string; vet_id: string }>('SELECT owner_id, vet_id FROM threads WHERE id = $1', [String(msg.threadId)]);
    const thread = rows[0];
    if (!thread || ![thread.owner_id, thread.vet_id].includes(userId)) return;
    const other = thread.owner_id === userId ? thread.vet_id : thread.owner_id;
    sendToUser(other, { type: 'typing', threadId: msg.threadId, userId });
    return;
  }

  if (msg.type === 'read') {
    const threadId = String(msg.threadId ?? '');
    await db.query(
      'UPDATE messages SET read_at = now() WHERE thread_id = $1 AND sender_id <> $2 AND read_at IS NULL',
      [threadId, userId],
    );
    return;
  }

  if (msg.type === 'webrtc') {
    const appointmentId = String(msg.appointmentId ?? '');
    const rows = await db.query<{ owner_id: string; vet_id: string; status: string }>(
      'SELECT owner_id, vet_id, status FROM appointments WHERE id = $1',
      [appointmentId],
    );
    const appt = rows[0];
    if (!appt || ![appt.owner_id, appt.vet_id].includes(userId)) {
      socket.send(JSON.stringify({ type: 'error', message: 'You are not part of this consultation' }));
      return;
    }
    if (appt.status !== 'accepted') {
      socket.send(JSON.stringify({ type: 'error', message: 'The consultation has not been accepted yet' }));
      return;
    }
    const other = appt.owner_id === userId ? appt.vet_id : appt.owner_id;
    sendToUser(other, {
      type: 'webrtc',
      appointmentId,
      fromUserId: userId,
      signal: msg.signal,
    });
    return;
  }

  socket.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
}

export function attachWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  // Reject upgrades before the handshake completes: wrong path, or an Origin
  // that is not this deployment's own site.
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    // `/ws` is the API's own path (the app served by this process uses it).
    // `/socket` and `/socket/` are the same endpoint behind Cloudflare Pages,
    // which does not route `/ws` to a Function and would answer the SPA HTML.
    if (pathname !== '/ws' && pathname !== '/socket' && pathname !== '/socket/') {
      socket.destroy();
      return;
    }
    if (!isAllowedSocketOrigin(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (socket, req) => {
    let userId: string | null = null;
    try {
      const url = new URL(req.url ?? '/ws', 'http://localhost');
      const token = url.searchParams.get('token') ?? '';
      const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
      if (!payload.sub) throw new Error('missing subject');
      const db = await getDb();
      const users = await db.query<{ id: string; disabled: boolean }>('SELECT id, disabled FROM users WHERE id = $1', [payload.sub]);
      if (!users[0] || users[0].disabled) throw new Error('no active user');
      userId = users[0].id;
    } catch {
      socket.close(4401, 'Unauthorized');
      return;
    }

    register(userId, socket);
    socket.send(JSON.stringify({ type: 'ready', userId }));

    socket.on('message', (data) => {
      if (!userId) return;
      handleMessage(userId, socket, data.toString()).catch((err) => {
        console.error('[ws] handler error', err);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'error', message: 'Could not process that message' }));
        }
      });
    });

    socket.on('close', () => {
      if (userId) unregister(userId, socket);
    });
    socket.on('error', () => {
      if (userId) unregister(userId, socket);
    });

    const interval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 30_000);
    socket.on('close', () => clearInterval(interval));
  });

  return wss;
}

export function closeWebSocket(): void {
  wss?.close();
  wss = null;
  clients.clear();
}
