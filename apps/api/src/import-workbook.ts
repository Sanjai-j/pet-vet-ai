import fs from 'node:fs';
import zlib from 'node:zlib';
import { closeDb } from './db.js';
import { importWorkbook, type SheetRows } from './services/nutrition-import.js';

/**
 * Nutrition workbook importer.
 *
 *   npm run import:workbook -- <path/to/file.xlsx>            validate + import
 *   npm run import:workbook -- <file.xlsx> --dry-run          validate only
 *
 * The workbook is treated as an untrusted candidate dataset: every sheet
 * and row is validated before anything is written, and all records land
 * in the administrator review queue as 'pending'. Approved records are
 * never overwritten by an import. See db/migrations/003_nutrition.sql.
 *
 * Reads .xlsx directly (ZIP of XML) with no external dependencies.
 */

// ── Minimal XLSX reader (inline strings + shared strings) ─────

function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  // Locate the end-of-central-directory record (signature 0x06054b50),
  // scanning back over the (optional) comment.
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
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
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

export function readXlsxSheets(filePath: string): SheetRows {
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

// ── CLI ───────────────────────────────────────────────────────

// Guarded so this module can be imported for its readXlsxSheets helper (e.g. by
// the QA harness) without triggering an import run. This top-level code used to
// execute on import, which fired the importer — and its validation errors —
// whenever another module merely imported the reader.
const isDirectRun = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isDirectRun) {
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('Usage: npm run import:workbook -- <path/to/workbook.xlsx> [--dry-run]');
  process.exitCode = 1;
} else if (!fs.existsSync(file)) {
  console.error(`[import] file not found: ${file}`);
  process.exitCode = 1;
} else {
  try {
    const sheets = readXlsxSheets(file);
    console.log(`[import] workbook: ${file}`);
    console.log(`[import] sheets: ${Object.keys(sheets).join(', ')}`);
    console.log(`[import] mode: ${dryRun ? 'DRY RUN (no writes)' : 'import as pending review records'}`);

    const report = await importWorkbook(sheets, { dryRun });

    for (const w of report.warnings) console.warn(`[import] warning: ${w}`);
    for (const e of report.errors) console.error(`[import] ERROR: ${e}`);
    if (report.errors.length) {
      console.error(`[import] ${report.errors.length} validation error(s) — nothing was written.`);
      process.exitCode = 1;
    } else {
      const parts = Object.entries(report.imported).map(([k, v]) => `${k}=${v}`);
      const skipped = Object.entries(report.skipped).map(([k, v]) => `${k}=${v}`);
      console.log(`[import] ${report.dryRun ? 'staged (dry run)' : 'imported'}: ${parts.join(' ') || 'none'}`);
      if (skipped.length) {
        console.log(`[import] skipped (already reviewed or unchanged): ${skipped.join(' ')}`);
      }
      console.log('[import] all records are pending veterinary review — approve them in the admin panel to publish.');
    }
  } catch (err) {
    console.error('[import] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
} // end if (isDirectRun)
