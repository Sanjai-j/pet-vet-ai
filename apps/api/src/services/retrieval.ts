import { many } from '../db.js';

export interface RetrievedSource {
  documentId: string;
  chunkId: string;
  title: string;
  sourceOrg: string;
  sourceUrl: string | null;
  isDemo: boolean;
  category: string;
  snippet: string;
  score: number;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'this', 'that', 'have', 'has',
  'was', 'were', 'from', 'they', 'them', 'his', 'her', 'its', 'our', 'can', 'could', 'should',
  'would', 'what', 'when', 'where', 'which', 'who', 'how', 'why', 'about', 'into', 'than', 'then',
  'there', 'their', 'been', 'being', 'does', 'did', 'doing', 'also', 'very', 'just', 'some', 'any',
  'all', 'more', 'most', 'much', 'many', 'such', 'only', 'own', 'same', 'too', 'now', 'get', 'got',
  'pet', 'dog', 'cat', 'animal', 'please', 'help', 'need', 'want', 'like', 'feel', 'think',
  // Meta-words about the owner's own record: they describe where an answer
  // comes from, not what it is about. Leaving them in matched unrelated
  // documents that merely contain "record the time...".
  'record', 'recorded', 'recording', 'log', 'logged',
  // How long something has lasted is not what it is about. "refused for 1 day"
  // used to retrieve a urinary-blockage document (it contains "within a day")
  // because "day" was the only query token that matched anything.
  'day', 'days', 'hour', 'hours', 'hr', 'hrs', 'week', 'weeks', 'month', 'months',
  'year', 'years', 'yesterday', 'today', 'tonight', 'morning', 'evening', 'night',
  'since', 'still', 'again', 'already', 'recently', 'lately', 'nowadays',
]);

/**
 * Casual owner phrasing is mapped onto the clinical term used in the corpus,
 * so lexical retrieval matches how people actually type symptoms
 * ("throwing up" / "puking" → "vomit", "paw" → "paw" kept as-is, etc.).
 * Applied to queries and documents identically.
 */
const SYNONYMS: Array<[RegExp, string]> = [
  [/\bthrow(?:ing|s|\u2019s)?\s+(?:up|\u2019em out)\b/g, 'vomit'],
  [/\bthrew\s+up\b/g, 'vomit'],
  [/\bpuk(?:e|es|ed|ing)\b/g, 'vomit'],
  [/\bbarf(?:s|ed|ing)?\b/g, 'vomit'],
  [/\bregurgitat\w*\b/g, 'vomit'],
  [/\bpoop(?:s|ed|ing)?\b/g, 'stool'],
  [/\bpoo\b/g, 'stool'],
  [/\bdiarrh(?:ea|oea)\b/g, 'diarrhoea'],
  [/\btummy\b/g, 'abdomen'],
  [/\bbelly\b/g, 'abdomen'],
  [/\bwee\b|\bwee-?wee\b/g, 'urine'],
  [/\bpiddle\b/g, 'urine'],
  [/\bsick\b/g, 'vomit'],
  [/\bpant(?:s|ed|ing)?\b/g, 'pant'],
  [/\bwater\s+in\s+the\s+(?:lungs|chest)\b/g, 'aspiration'],
];

export function normalizeSymptoms(text: string): string {
  let out = text.toLowerCase();
  for (const [re, to] of SYNONYMS) out = out.replace(re, to);
  return out;
}

/**
 * Very light plural folding so "vaccinations" matches "vaccination" and
 * "doses" matches "dose". Words ending in ss/us/is/as are left alone
 * (status, analysis, stress) because the trailing s is part of the word.
 */
export function singular(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('s') && !/(ss|us|is|as)$/.test(token)) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  return normalizeSymptoms(text)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => singular(t.replace(/^-+|-+$/g, '')))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

interface ChunkRow {
  documentId: string;
  chunkId: string;
  title: string;
  sourceOrg: string;
  sourceUrl: string | null;
  isDemo: boolean;
  category: string;
  content: string;
}

/**
 * Scores below this are incidental single-word hits (e.g. "vomiting" appearing
 * once in an unrelated emergency document), not topical matches. Citing them
 * made the assistant answer symptom questions with off-topic references.
 * Calibrated against the corpus: topical matches score >= 0.3, incidental
 * mentions <= 0.15.
 */
export const MIN_RELEVANCE_SCORE = 0.2;

export async function retrieveSources(
  queryText: string,
  speciesCode: string,
  limit = 4,
): Promise<RetrievedSource[]> {
  const rows = await many<ChunkRow>(
    `SELECT d.id AS "documentId", c.id AS "chunkId", d.title, d.source_org AS "sourceOrg",
            d.source_url AS "sourceUrl", d.is_demo AS "isDemo", d.category, c.content
     FROM knowledge_chunks c
     JOIN knowledge_documents d ON d.id = c.document_id
     WHERE d.status = 'approved'
       AND ($1 = ANY(d.species) OR 'all' = ANY(d.species))
     ORDER BY d.title, c.chunk_index`,
    [speciesCode],
  );

  const queryTokens = tokenize(queryText);
  if (!queryTokens.length || !rows.length) return [];

  const docs = rows.map((r) => tokenize(`${r.title} ${r.category} ${r.content}`));
  const df = new Map<string, number>();
  for (const tokens of docs) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = docs.length;

  const scored = rows.map((row, i) => {
    const tokens = docs[i];
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    let score = 0;
    for (const q of queryTokens) {
      const tf = counts.get(q) ?? 0;
      if (!tf) continue;
      const idf = Math.log((N + 1) / ((df.get(q) ?? 0) + 0.5));
      score += (1 + Math.log(tf)) * Math.max(idf, 0.05);
    }
    const titleTokens = tokenize(row.title);
    for (const q of queryTokens) if (titleTokens.includes(q)) score += 0.8;
    const norm = Math.sqrt(tokens.length || 1);
    return {
      covered: [...new Set(queryTokens)].filter((q) => counts.has(q)),
      titleCovered: [...new Set(queryTokens)].filter((q) => titleTokens.includes(q)),
      documentId: row.documentId,
      chunkId: row.chunkId,
      title: row.title,
      sourceOrg: row.sourceOrg,
      sourceUrl: row.sourceUrl,
      isDemo: row.isDemo,
      category: row.category,
      snippet: row.content.length > 900 ? `${row.content.slice(0, 900)}…` : row.content,
      score: Number((score / norm).toFixed(4)),
    };
  });

  return scored
    // One shared word is a coincidence, not a topic — unless that word names
    // the document. Two independent words, or a word in the title, is the
    // smallest evidence that the reference is about this question.
    .filter((s) => s.covered.length >= 2 || s.titleCovered.length >= 1)
    .filter((s) => s.score >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    // Coverage is a ranking gate, not part of the public source shape.
    .map((s) => ({
      documentId: s.documentId,
      chunkId: s.chunkId,
      title: s.title,
      sourceOrg: s.sourceOrg,
      sourceUrl: s.sourceUrl,
      isDemo: s.isDemo,
      category: s.category,
      snippet: s.snippet,
      score: s.score,
    }));
}
