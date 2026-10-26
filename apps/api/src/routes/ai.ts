import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler, forbidden, notFound, parse } from '../errors.js';
import { getDb, many, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { loadPet } from '../access.js';
import { generateAiReply, aiRuntimeInfo } from '../services/ai.js';
import { EXA_SETUP_MESSAGE, searchWeb, webSearchConfigured } from '../services/exa-search.js';
import { config } from '../config.js';
import { audit } from '../audit.js';

export const aiRouter = Router();
aiRouter.use(requireAuth);

aiRouter.get(
  '/ai/status',
  asyncHandler(async (_req, res) => {
    const settings = await one<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'ai'`);
    res.json({
      ...aiRuntimeInfo(),
      // Boolean only: the Exa key itself never leaves the server.
      webSearch: {
        configured: webSearchConfigured(),
        setupMessage: webSearchConfigured() ? null : EXA_SETUP_MESSAGE,
      },
      settings: settings?.value ?? {},
      message: 'AI output is general information, not a diagnosis or prescription.',
    });
  }),
);

aiRouter.get(
  '/ai/web-search',
  asyncHandler(async (req, res) => {
    const { q } = parse(z.object({ q: z.string().trim().min(3).max(300) }), req.query);
    res.json(await searchWeb(q));
  }),
);

aiRouter.get(
  '/ai/conversations',
  asyncHandler(async (req, res) => {
    const petId = typeof req.query.petId === 'string' ? req.query.petId : '';
    const rows = await many(
      `SELECT c.id, c.pet_id AS "petId", c.species_code AS "speciesCode", c.title,
              c.created_at AS "createdAt",
              (SELECT count(*)::int FROM ai_messages m WHERE m.conversation_id = c.id) AS "messageCount"
       FROM ai_conversations c
       WHERE c.owner_id = $1 AND ($2 = '' OR c.pet_id = $2)
       ORDER BY c.created_at DESC LIMIT 30`,
      [req.user!.id, petId],
    );
    res.json({ conversations: rows });
  }),
);

aiRouter.get(
  '/ai/conversations/:id',
  asyncHandler(async (req, res) => {
    const conversation = await one<{ id: string; owner_id: string; pet_id: string; title: string }>(
      'SELECT id, owner_id, pet_id, title FROM ai_conversations WHERE id = $1',
      [req.params.id],
    );
    if (!conversation) throw notFound('Conversation not found');
    if (conversation.owner_id !== req.user!.id && req.user!.role !== 'admin') throw forbidden();
    const messages = await many(
      `SELECT id, role, content, citations, emergency, capability_status AS "capabilityStatus",
              is_demo AS "isDemo", created_at AS "createdAt"
       FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at`,
      [conversation.id],
    );
    res.json({ conversation, messages });
  }),
);

aiRouter.delete(
  '/ai/conversations/:id',
  asyncHandler(async (req, res) => {
    const conversation = await one<{ owner_id: string }>(
      'SELECT owner_id FROM ai_conversations WHERE id = $1',
      [req.params.id],
    );
    if (!conversation) throw notFound('Conversation not found');
    if (conversation.owner_id !== req.user!.id && req.user!.role !== 'admin') throw forbidden();
    await (await getDb()).query('DELETE FROM ai_conversations WHERE id = $1', [req.params.id]);
    res.status(204).send();
  }),
);

aiRouter.post(
  '/ai/chat',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        petId: z.string().min(1),
        message: z.string().min(2, 'Describe what you are seeing').max(4000),
        conversationId: z.string().optional(),
      }),
      req.body,
    );
    const user = req.user!;
    if (user.role === 'vet') throw forbidden('Pet Vet AI conversations are for pet owners');
    const pet = await loadPet(body.petId, user);
    if (pet.ownerId !== user.id && user.role !== 'admin') throw forbidden();

    const db = await getDb();
    const used = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_messages m
       JOIN ai_conversations c ON c.id = m.conversation_id
       WHERE c.owner_id = $1 AND m.role = 'user' AND m.created_at > now() - interval '1 day'`,
      [user.id],
    );
    if (Number(used?.n ?? 0) >= config.aiMaxMessagesPerDay) {
      throw new ApiError(429, 'ai_daily_limit', `Daily AI message limit reached (${config.aiMaxMessagesPerDay}). Please try again tomorrow or contact a veterinarian.`);
    }

    let conversationId = body.conversationId ?? '';
    let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (conversationId) {
      const convo = await one<{ id: string; owner_id: string; pet_id: string }>(
        'SELECT id, owner_id, pet_id FROM ai_conversations WHERE id = $1',
        [conversationId],
      );
      if (!convo) throw notFound('Conversation not found');
      if (convo.owner_id !== user.id) throw forbidden();
      if (convo.pet_id !== pet.id) throw new ApiError(400, 'bad_request', 'Conversation belongs to another pet');
      const prior = await many<{ role: 'user' | 'assistant'; content: string }>(
        `SELECT role, content FROM ai_messages WHERE conversation_id = $1 AND role IN ('user','assistant')
         ORDER BY created_at DESC LIMIT 8`,
        [conversationId],
      );
      history = prior.reverse();
    } else {
      conversationId = crypto.randomUUID();
      await db.query(
        `INSERT INTO ai_conversations (id, owner_id, pet_id, species_code, title)
         VALUES ($1, $2, $3, $4, $5)`,
        [conversationId, user.id, pet.id, pet.speciesCode, body.message.slice(0, 70)],
      );
    }

    await db.query(
      `INSERT INTO ai_messages (id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`,
      [crypto.randomUUID(), conversationId, body.message],
    );

    const reply = await generateAiReply(
      {
        id: pet.id,
        name: pet.name,
        speciesCode: pet.speciesCode,
        breedName: pet.breedName,
        ageEstimateMonths: pet.ageEstimateMonths ?? null,
        weightKg: pet.weightKg ?? null,
        conditions: pet.conditions ?? null,
      },
      body.message,
      history,
    );

    const replyId = crypto.randomUUID();
    await db.query(
      `INSERT INTO ai_messages
        (id, conversation_id, role, content, citations, emergency, capability_status, is_demo)
       VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7)`,
      [
        replyId, conversationId, reply.answer, JSON.stringify(reply.citations),
        Boolean(reply.emergency), reply.capability.status, reply.mode !== 'llm',
      ],
    );
    // Diagnostic metadata only: the red flag, how the answer was produced,
    // whether the model was tried and the provider's sanitised failure text.
    // Never the message body, the key or any token.
    await audit(user.id, 'ai.message', 'ai_conversation', conversationId, {
      emergency: reply.emergency?.ruleId ?? null,
      // true when the red flag came from the previous turn, so an operator can
      // tell a fresh incident from a conversation that is still unresolved.
      emergencyContinued: Boolean(reply.emergencyContinued),
      urgency: reply.urgency,
      capability: reply.capability.status,
      mode: reply.mode,
      modeReason: reply.modeReason,
      llmAttempted: Boolean(reply.llmAttempted),
      providerError: reply.providerError ?? null,
    });

    res.status(201).json({
      conversationId,
      reply: { ...reply, id: replyId, createdAt: new Date().toISOString() },
    });
  }),
);
