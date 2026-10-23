import { closeDb, getDb } from '../src/db.js';
import { retrieveSources } from '../src/services/retrieval.js';

async function main(): Promise<void> {
  const db = await getDb();

  const stats = await db.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM knowledge_documents
      WHERE id LIKE 'bw_%' GROUP BY status ORDER BY status`,
  );
  console.log('breedwise documents by status:', stats.map((s) => `${s.status}=${s.n}`).join(' ') || 'none');

  const chunkStats = await db.query<{ n: number; chunks: number }>(
    `SELECT count(DISTINCT d.id)::int AS n, count(c.id)::int AS chunks
       FROM knowledge_documents d LEFT JOIN knowledge_chunks c ON c.document_id = d.id
      WHERE d.id LIKE 'bw_%'`,
  );
  console.log(`docs with chunks: ${chunkStats[0].n}, total chunks: ${chunkStats[0].chunks}`);

  const sample = await db.query<{ id: string; title: string; category: string; species: string[]; chars: number }>(
    `SELECT id, title, category, species, length(content)::int AS chars
       FROM knowledge_documents WHERE id LIKE 'bw_%' ORDER BY id LIMIT 3`,
  );
  console.log('\nsample documents:');
  for (const s of sample) {
    console.log(`  ${s.id} | ${s.category} | [${s.species.join(',')}] | ${s.chars} chars\n    ${s.title}`);
  }

  // Safety check: retrieval must NOT surface pending breedwise docs.
  const hits = await retrieveSources('vomiting labrador', 'dog', 10);
  const bwHits = hits.filter((h) => h.documentId.startsWith('bw_'));
  console.log(`\nretrieveSources("vomiting labrador", dog) returned ${hits.length} sources; breedwise(pending) leaks: ${bwHits.length}`);
  if (bwHits.length) {
    console.error('  LEAK:', bwHits.map((h) => h.documentId).join(', '));
    process.exitCode = 1;
  } else {
    console.log('  OK: pending breedwise docs are invisible to the AI retrieval path.');
  }

  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
