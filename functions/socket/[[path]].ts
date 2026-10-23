import { proxy, type ProxyEnv } from '../../infra/cloudflare/proxy';

interface PagesContext {
  request: Request;
  env: ProxyEnv;
}

/**
 * The chat and video-call signalling socket.
 *
 * The Angular client opens `wss://<pages-host>/socket?token=…`; this Function
 * forwards the upgrade to the Render service, which answers 101 and then talks
 * to the browser through the tunnel Cloudflare keeps open. The browser's Origin
 * header is preserved, so the API still enforces its own WEB_ORIGIN check.
 *
 * The path is `/socket` and not `/ws` because Cloudflare Pages does not route
 * `/ws` to a Function: a probe Function declared there was never invoked and
 * `GET /ws` returned the SPA HTML instead (`wrangler pages dev`). The
 * catch-all file name makes `/socket` itself a route;
 * `functions/socket/index.ts` only answered `/socket/`. The API's own socket
 * handler accepts `/ws`, `/socket` and `/socket/`.
 */
export const onRequest = (context: PagesContext): Promise<Response> =>
  proxy(context.request, context.env);
