// Named import: this package ships an ESM build whose default export is not
// constructable under NodeNext module resolution.
import { Exa } from 'exa-js';
import { config } from '../config.js';
import { ApiError } from '../errors.js';

/**
 * Live web search for the Pet Vet AI page.
 *
 * Exa is used only as supplementary reading next to the assistant's answer:
 * its pages are never treated as approved references and never feed clinical
 * claims (see services/ai.ts). The API key stays on the server.
 */

export interface WebSearchResult {
  title: string | null;
  url: string;
  publishedDate: string | null;
  author: string | null;
  /** Query-relevant passages from the page (Exa highlights). */
  highlights: string[];
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  notice: string;
}

/** Setup guidance shown when EXA_API_KEY is absent. */
export const EXA_SETUP_MESSAGE =
  'Live web search is not configured. Add EXA_API_KEY to the server .env to enable it. ' +
  'Web results are supplementary reading only — they are not approved references and are never used for clinical claims.';

const WEB_RESULTS_NOTICE =
  'Web results come from Exa and link to live third-party pages. They are not Pet Vet AI approved references, ' +
  'may be inaccurate or out of date, and never replace a veterinarian. Coverage is never complete.';

export function webSearchConfigured(): boolean {
  return Boolean(config.exa.apiKey);
}

let cachedClient: Exa | null = null;
let cachedKey = '';

function exaClient(): Exa {
  if (!config.exa.apiKey) {
    throw new ApiError(503, 'web_search_not_configured', EXA_SETUP_MESSAGE);
  }
  if (!cachedClient || cachedKey !== config.exa.apiKey) {
    cachedClient = new Exa(config.exa.apiKey);
    cachedKey = config.exa.apiKey;
  }
  return cachedClient;
}

/**
 * Turn an Exa/network failure into an error the feature can show.
 * Upstream problems are reported as 502 so the browser is never told that
 * its own request was wrong, and never sees the provider's raw response.
 */
function toApiError(err: unknown): ApiError {
  const statusCode = (err as { statusCode?: unknown })?.statusCode;
  const status = typeof statusCode === 'number' ? statusCode : null;
  if (status === 401 || status === 403) {
    return new ApiError(
      502,
      'web_search_auth_failed',
      'Exa rejected the configured API key. Check EXA_API_KEY on the server.',
    );
  }
  if (status === 402) {
    return new ApiError(
      502,
      'web_search_credits_exhausted',
      'The Exa account has run out of credits. Add credits in the Exa dashboard to keep live web search running.',
    );
  }
  if (status === 429) {
    return new ApiError(429, 'web_search_rate_limited', 'Exa rate limit reached. Please wait a moment and try again.');
  }
  if (status == null) {
    return new ApiError(
      502,
      'web_search_unavailable',
      'Could not reach Exa. Check the server network connection and try again.',
    );
  }
  return new ApiError(502, 'web_search_failed', `Exa web search failed (${status}). Please try again.`);
}

/** One live web search: a query in, the fields the UI shows out. */
export async function searchWeb(query: string, options: { numResults?: number } = {}): Promise<WebSearchResponse> {
  const exa = exaClient();
  const numResults = Math.min(Math.max(options.numResults ?? 5, 1), 10);
  try {
    const response = await exa.search(query, {
      type: 'auto',
      numResults,
      contents: { highlights: true },
    });
    return {
      query,
      results: response.results.map((result) => ({
        title: result.title ?? null,
        url: result.url,
        publishedDate: result.publishedDate ?? null,
        author: result.author ?? null,
        highlights: (result.highlights ?? []).slice(0, 2),
      })),
      notice: WEB_RESULTS_NOTICE,
    };
  } catch (err) {
    console.error('[exa] web search failed', err instanceof Error ? err.message : err);
    throw toApiError(err);
  }
}
