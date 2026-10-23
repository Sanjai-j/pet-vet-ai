import { proxy, type ProxyEnv } from '../../infra/cloudflare/proxy';

interface PagesContext {
  request: Request;
  env: ProxyEnv;
}

/**
 * Handles every REST call the Angular app makes on its own origin.
 *
 * `_routes.json` (copied from apps/web/public) limits this Function to `/api/*`
 * so static assets never invoke compute. The file name gives the route:
 * `functions/api/[[path]].ts` matches `/api` and anything below it.
 */
export const onRequest = (context: PagesContext): Promise<Response> =>
  proxy(context.request, context.env);
