/**
 * Edge proxy for the PetVet AI API.
 *
 * The Angular app calls the API on its own origin (`/api/...`) and opens the
 * chat socket on `ws://<same host>/ws`. Serving the app from Cloudflare Pages
 * and the API from Render therefore only works if something bridges the two
 * without changing those URLs: the Pages Functions in `functions/` hand every
 * `/api/*` and `/ws` request to this module.
 *
 * What it does:
 *  - forwards method, path, query string, headers and the request body
 *    unchanged, so bearer auth, multipart uploads and downloads behave exactly
 *    as they do when the API serves the app itself;
 *  - forwards the browser's `Origin` untouched, so the API keeps validating
 *    sockets against `WEB_ORIGIN` instead of trusting the edge blindly;
 *  - passes WebSocket upgrades straight through (Cloudflare's runtime tunnels
 *    the connection once the upstream answers 101);
 *  - turns Render's cold-start and outage responses into a message a person can
 *    read, instead of an opaque 502.
 */

export interface ProxyEnv {
  /** Base URL of the Render service, e.g. https://petvet-api.onrender.com */
  API_ORIGIN?: string;
}

/** Cloudflare closes a request at 100 s; stop short of that with our own reason. */
const UPSTREAM_TIMEOUT_MS = 95_000;

/** Headers that describe a single hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const API_DOWN_MESSAGE =
  'The PetVet API is waking up or temporarily unavailable. Render free instances sleep when idle, ' +
  'so the first request can take up to a minute. Please retry shortly.';

function json(status: number, code: string, message: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function text(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * True for the paths this proxy owns; everything else is a Pages asset.
 *
 * The socket lives at `/socket` rather than `/ws`: Cloudflare Pages answers
 * `/ws` itself (the path is reserved by the platform) and never reaches a
 * Function, so the browser socket uses `/socket` and the API serves the same
 * handler on both paths.
 */
export const SOCKET_PATH = '/socket';

export function isProxiedPath(pathname: string): boolean {
  return (
    pathname === SOCKET_PATH ||
    pathname === `${SOCKET_PATH}/` ||
    pathname === '/api' ||
    pathname.startsWith('/api/')
  );
}

function normaliseOrigin(raw: string | undefined): string | null {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Copy the client's headers, minus the ones that only make sense per hop. */
function forwardedHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  // Let the upstream see its own host, but keep the browser's Origin: the API's
  // WebSocket check compares it with WEB_ORIGIN.
  headers.delete('host');
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) headers.set('x-forwarded-for', clientIp);
  headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''));
  headers.set('x-forwarded-host', new URL(request.url).host);
  return headers;
}

export async function proxy(request: Request, env: ProxyEnv): Promise<Response> {
  const origin = normaliseOrigin(env?.API_ORIGIN);
  if (!origin) {
    return json(
      500,
      'proxy_not_configured',
      'This deployment has no API_ORIGIN configured, so the app cannot reach its API. ' +
        'Set API_ORIGIN to the Render service URL in Cloudflare Pages → Settings → Environment variables.',
    );
  }

  const url = new URL(request.url);
  if (!isProxiedPath(url.pathname)) {
    // Functions are scoped to /api and /ws by _routes.json; this is only a guard.
    return json(404, 'not_proxied', `The edge proxy does not forward ${url.pathname}.`);
  }

  const target = `${origin}${url.pathname}${url.search}`;
  const isWebSocket = (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';

  if (isWebSocket) {
    // No timeout: this fetch is the socket itself. The upgrade has to travel as
    // the original Request object — `Upgrade` is a forbidden header in the Fetch
    // API, so rebuilding it from a copied Headers map silently downgrades the
    // request to a plain GET (the API answers 200 with the SPA HTML). Constructing
    // a Request with the client request as init keeps the upgrade intact, and the
    // runtime then tunnels the connection once the API answers 101.
    try {
      const upstream = await fetch(new Request(target, request));
      if (upstream.status !== 101) {
        // The API refused the handshake (bad token, wrong origin, asleep). Keep
        // its status so a 401/403 stays distinguishable from an outage.
        const detail = await upstream.text().catch(() => '');
        const message =
          `The API refused the WebSocket handshake (HTTP ${upstream.status}). ` +
          (detail.slice(0, 200) || API_DOWN_MESSAGE);
        return text(upstream.status >= 400 ? upstream.status : 502, message);
      }
      return upstream;
    } catch (err) {
      console.warn('[proxy] websocket upstream failed', (err as Error)?.message);
      return text(502, API_DOWN_MESSAGE);
    }
  }

  const init: RequestInit = {
    method: request.method,
    headers: forwardedHeaders(request),
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    // Stream the body straight through so multipart uploads are not buffered.
    (init as RequestInit & { duplex?: string }).duplex = 'half';
    init.body = request.body;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError';
    console.warn('[proxy] upstream request failed', (err as Error)?.message);
    return aborted
      ? json(504, 'upstream_timeout', API_DOWN_MESSAGE, { 'Retry-After': '30' })
      : json(502, 'upstream_unreachable', API_DOWN_MESSAGE, { 'Retry-After': '30' });
  }

  // Render answers 502/503/504 while a free instance boots or is being replaced.
  // Replace those with the explanation rather than passing an HTML error page on.
  if (upstream.status === 502 || upstream.status === 503 || upstream.status === 504) {
    await upstream.body?.cancel();
    return json(503, 'upstream_unavailable', API_DOWN_MESSAGE, { 'Retry-After': '30' });
  }

  return upstream;
}
