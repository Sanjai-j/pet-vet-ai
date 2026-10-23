import { getDb, id } from './db.js';

export async function audit(
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO audit_logs (id, actor_id, action, entity, entity_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id(), actorId, action, entity, entityId, JSON.stringify(meta)],
  );
}
