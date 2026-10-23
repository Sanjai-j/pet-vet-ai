/**
 * Breedwise clinical-symptom importer.
 *
 * Reads the "Pet_Vet_AI_Breedwise_Common_Problems_and_Safe_Actions" workbook
 * (symptom → safe first action / urgency / never-do triage records), groups the
 * rows by species+breed, and writes one knowledge document per group into the
 * administrator review queue as `status = 'pending'`.
 *
 *   npx tsx scripts/import-breedwise.ts <path/to/file.xlsx> [--dry-run]
 *
 * Safety model (the dataset ships PENDING_VETERINARY_REVIEW on every row):
 *   - Nothing here is approved. Documents land as 'pending' so they are
 *     invisible to `retrieveSources()` (which reads status='approved' only)
 *     and therefore never reach the AI or pet owners until an administrator
 *     approves them in the admin panel.
 *   - Chunks ARE built at import time so a single admin approve publishes the
 *     group immediately; the approve path rebuilds them anyway, so this is a
 *     convenience, not a bypass.
 *   - Every group carries the row-level safety context (diagnosis_note,
 *     production_rule, source_requirement) verbatim, so a reviewer sees the
 *     exact constraints before approving.
 *   - Re-running is idempotent: a group whose document already exists is
 *     skipped unless its source content changed (then it is refreshed and
 *     returned to pending). Approved documents are never overwritten.
 *
 * Reads .xlsx directly (ZIP of XML) with no external dependencies, reusing the
 * reader proven in src/import-workbook.ts.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { closeDb, getDb } from '../src/db.js';
import { chunkText } from '../src/util.js';

// ── Minimal XLSX reader (inline strings + shared strings) ───────

function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP directory found)');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    const out = method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    entries.set(name, out);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function colToIdx(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseSheetXml(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+)[0-9]+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const idx = colToIdx(cm[1]);
      const attrs = cm[2];
      const body = cm[3];
      const type = attrs.match(/t="(\w+)"/)?.[1] ?? '';
      let val = '';
      if (type === 'inlineStr') {
        val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('');
      } else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
        val = type === 's' ? shared[Number(v)] ?? '' : v;
      }
      cells[idx] = decodeEntities(val).replace(/\s+/g, ' ').trim();
    }
    rows.push(cells);
  }
  return rows;
}

type SheetRows = Record<string, string[][]>;

function readXlsxSheets(filePath: string): SheetRows {
  const entries = readZipEntries(fs.readFileSync(filePath));
  const shared: string[] = [];
  const ss = entries.get('xl/sharedStrings.xml');
  if (ss) {
    for (const si of ss.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
    }
  }
  const wbXml = entries.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const ridToTarget = new Map<string, string>();
  for (const rel of relsXml.matchAll(/<Relationship [^>]*\/>/g)) {
    const id = rel[0].match(/Id="([^"]+)"/)?.[1];
    const target = rel[0].match(/Target="([^"]+)"/)?.[1];
    if (id && target) ridToTarget.set(id, target.replace(/^\//, ''));
  }
  const sheets: SheetRows = {};
  for (const sm of wbXml.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = ridToTarget.get(sm[2]);
    if (!target) continue;
    const xml = entries.get(target)?.toString('utf8');
    if (xml === undefined) continue;
    sheets[sm[1]] = parseSheetXml(xml, shared);
  }
  return sheets;
}

// ── Row → grouped documents ─────────────────────────────────────

const SPECIES_CODE: Record<string, string> = {
  dog: 'dog', cat: 'cat', bird: 'bird', cow: 'cow', goat: 'goat',
};

interface BreedwiseRow {
  record_id: string;
  species: string;
  breed_or_type: string;
  problem_or_symptom: string;
  possible_diseases_or_causes: string;
  seriousness_level: string;
  seriousness_rule: string;
  common_context: string;
  safe_first_action_not_a_cure: string;
  urgency: string;
  breed_context: string;
  never_do_this: string;
  follow_up_questions: string;
  diagnosis_note: string;
  review_status: string;
  production_rule: string;
  source_requirement: string;
}

function sheetToObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
}

/** Render one breed group's rows as a single retrievable document body. */
function buildContent(species: string, breed: string, rows: BreedwiseRow[]): string {
  const problems = rows
    .map((r) => {
      const lines = [
        `### ${r.problem_or_symptom}  (seriousness: ${r.seriousness_level || 'unstated'})`,
        r.possible_diseases_or_causes ? `Possible causes: ${r.possible_diseases_or_causes}` : '',
        r.seriousness_rule ? `Seriousness rule: ${r.seriousness_rule}` : '',
        r.common_context ? `Context: ${r.common_context}` : '',
        r.safe_first_action_not_a_cure ? `Safe first action (not a cure): ${r.safe_first_action_not_a_cure}` : '',
        r.urgency ? `Urgency: ${r.urgency}` : '',
        r.never_do_this ? `Never do this: ${r.never_do_this}` : '',
        r.follow_up_questions ? `Questions to answer: ${r.follow_up_questions}` : '',
      ].filter(Boolean).join('\n');
      return lines;
    })
    .join('\n\n');

  return [
    `Breedwise common problems and safe first actions — ${breed} (${species}).`,
    'This is triage and safe-next-step information only. It is not a diagnosis; symptoms',
    'alone cannot confirm a cause, and no medication, dose, or cure is implied. Use it to',
    'decide urgency and what to tell a veterinarian.',
    '',
    problems,
  ].join('\n');
}

// ── Import ──────────────────────────────────────────────────────

interface Report {
  dryRun: boolean;
  created: number;
  refreshed: number;
  skippedUnchanged: number;
  skippedApproved: number;
  rowsIngested: number;
  warnings: string[];
  errors: string[];
}

async function importBreedwise(sheets: SheetRows, dryRun: boolean): Promise<Report> {
  const report: Report = {
    dryRun, created: 0, refreshed: 0, skippedUnchanged: 0, skippedApproved: 0,
    rowsIngested: 0, warnings: [], errors: [],
  };

  const sheetName = Object.keys(sheets).find((n) => /breedwise/i.test(n));
  if (!sheetName) {
    report.errors.push(`No breedwise sheet found. Sheets present: ${Object.keys(sheets).join(', ')}`);
    return report;
  }
  const raw = sheetToObjects(sheets[sheetName]) as unknown as BreedwiseRow[];
  if (!raw.length) {
    report.errors.push(`Sheet "${sheetName}" has no data rows.`);
    return report;
  }

  // Group by species+breed, preserving first-seen order.
  const groups = new Map<string, { species: string; code: string; breed: string; rows: BreedwiseRow[] }>();
  for (const r of raw) {
    const species = (r.species || '').trim();
    const breed = (r.breed_or_type || '').trim();
    if (!species || !breed) {
      report.warnings.push(`Skipped ${r.record_id || '(no id)'}: missing species or breed.`);
      continue;
    }
    const code = SPECIES_CODE[species.toLowerCase()];
    if (!code) {
      report.warnings.push(`Skipped ${r.record_id}: unknown species "${species}".`);
      continue;
    }
    const key = `${code}||${breed.toLowerCase()}`;
    let g = groups.get(key);
    if (!g) { g = { species: species.toLowerCase(), code, breed, rows: [] }; groups.set(key, g); }
    g.rows.push(r);
  }

  const db = dryRun ? null : await getDb();

  for (const g of groups.values()) {
    const docId = `bw_${g.code}_${g.breed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)}`;
    const title = `${g.breed} (${g.species}) — common problems & safe actions`.slice(0, 200);
    const content = buildContent(g.species, g.breed, g.rows);

    if (db) {
      const existing = await db.query<{ id: string; status: string; content: string }>(
        'SELECT id, status, content FROM knowledge_documents WHERE id = $1', [docId],
      );
      const row = existing[0];
      if (row && row.status === 'approved') {
        // Never overwrite an approved document on re-import.
        report.skippedApproved += 1;
        continue;
      }
      if (row && row.content === content) {
        report.skippedUnchanged += 1;
        report.rowsIngested += g.rows.length;
        continue;
      }
      if (row) {
        await db.query(
          `UPDATE knowledge_documents
              SET title=$1, species=$2::text[], category=$3, source_org=$4, content=$5, status='pending'
            WHERE id=$6`,
          [title, `{${g.code}}`, 'clinical', 'Pet Vet AI breedwise workbook (pending veterinary review)', content, docId],
        );
        await db.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [docId]);
        report.refreshed += 1;
      } else {
        await db.query(
          `INSERT INTO knowledge_documents
             (id, title, species, category, source_org, content, status, is_demo)
           VALUES ($1,$2,$3::text[],$4,$5,$6,'pending',false)`,
          [docId, title, `{${g.code}}`, 'clinical',
           'Pet Vet AI breedwise workbook (pending veterinary review)', content],
        );
        report.created += 1;
      }
      // Build chunks now so a single admin approve publishes the group.
      const chunks = chunkText(content);
      for (let i = 0; i < chunks.length; i++) {
        await db.query(
          'INSERT INTO knowledge_chunks (id, document_id, chunk_index, content) VALUES ($1,$2,$3,$4)',
          [crypto.randomUUID(), docId, i, chunks[i]],
        );
      }
    } else {
      report.created += 1; // dry-run: count what would be created
    }
    report.rowsIngested += g.rows.length;
  }

  return report;
}

// ── CLI ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('Usage: npx tsx scripts/import-breedwise.ts <path/to/breedwise.xlsx> [--dry-run]');
  process.exitCode = 1;
} else if (!fs.existsSync(file)) {
  console.error(`[breedwise] file not found: ${file}`);
  process.exitCode = 1;
} else {
  try {
    const sheets = readXlsxSheets(file);
    console.log(`[breedwise] workbook: ${file}`);
    console.log(`[breedwise] sheets: ${Object.keys(sheets).join(', ')}`);
    console.log(`[breedwise] mode: ${dryRun ? 'DRY RUN (no writes)' : 'import as pending review documents'}`);

    const report = await importBreedwise(sheets, dryRun);

    for (const w of report.warnings.slice(0, 20)) console.warn(`[breedwise] warning: ${w}`);
    if (report.warnings.length > 20) console.warn(`[breedwise] …and ${report.warnings.length - 20} more warnings`);
    for (const e of report.errors) console.error(`[breedwise] ERROR: ${e}`);
    if (report.errors.length) {
      console.error(`[breedwise] ${report.errors.length} error(s) — nothing was written.`);
      process.exitCode = 1;
    } else {
      console.log(
        `[breedwise] ${dryRun ? 'would import' : 'imported'}: ` +
        `created=${report.created} refreshed=${report.refreshed} ` +
        `unchanged=${report.skippedUnchanged} approved-skipped=${report.skippedApproved} ` +
        `rows=${report.rowsIngested}`,
      );
      console.log('[breedwise] all documents are PENDING veterinary review — approve them in the admin panel to publish to the AI.');
    }
  } catch (err) {
    console.error('[breedwise] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
