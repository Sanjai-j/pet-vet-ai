import { closeDb, getDb } from '../src/db.js';
import { retrieveSources } from '../src/services/retrieval.js';

const DOC = 'bw_dog_labrador_retriever';
const QUERY = 'labrador vomiting what to do';

async function main(): Promise<void> {
  const db = await getDb();

  const before = await (await import('../src/services/retrieval.js')).retrieveSources(QUERY, 'dog', 10);
  console.log(`before approve: ${before.filter((h) => h.documentId === DOC).length ? 'CITED (unexpected)' : 'not cited (expected)'}`);

  await db.query(
    `UPDATE knowledge_documents SET status='approved', reviewed_by=(SELECT id FROM users WHERE role='admin' LIMIT 1), reviewed_at=now() WHERE id=$1`,
    [DOC],
  );

  const after = await retrieveSources(QUERY, 'dog', 10);
  const hit = after.find((h) => h.documentId === DOC);
  console.log(`after approve:  ${hit ? 'CITED ✓' : 'not cited (UNEXPECTED)'}`);
  if (hit) {
    console.log(`  title: ${hit.title}`);
    console.log(`  category: ${hit.category} | score: ${hit.score}`);
    console.log(`  snippet: ${hit.snippet.slice(0, 200)}…`);
  } else {
    console.error('  top hits:', after.map((h) => `${h.documentId}(${h.score})`).join(', '));
    process.exitCode = 1;
  }

  // Restore the review gate so the dataset stays pending until a real admin approves.
  await db.query(
    `UPDATE knowledge_documents SET status='pending', reviewed_by=NULL, reviewed_at=NULL WHERE id=$1`,
    [DOC],
  );
  const restored = await retrieveSources(QUERY, 'dog', 10);
  console.log(`restored to pending: ${restored.filter((h) => h.documentId === DOC).length ? 'still cited (UNEXPECTED)' : 'no longer cited ✓'}`);

  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
