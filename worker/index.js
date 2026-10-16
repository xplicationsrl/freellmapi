// Serves the dashboard from static assets and forwards API traffic to the
// self-hosted backend (BACKEND_URL), so the UI talks to its own origin.
// /u/<name>/... addresses a per-user instance; the server-side router maps
// the prefix to that user's backend.
const API_PATH = /^(?:\/u\/[a-z0-9-]+)?\/(?:api|v1|v1beta|mcp)(?:\/|$)/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // A dashboard page under an instance prefix: same SPA, the client reads
    // the prefix from the address bar.
    if (!API_PATH.test(url.pathname)) {
      return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }

    const target = new URL(url.pathname + url.search, env.BACKEND_URL);
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') ?? '');
    headers.set('X-Forwarded-Proto', 'https');
    return fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });
  },
};
