// VITE_API_URL points a separately hosted dashboard (e.g. Cloudflare Pages) at
// a backend on another origin. Unset, the API is same-origin under BASE_URL.
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

// Per-user instances are served under /u/<name>/ on the same origin: the
// dashboard, its API and the /v1 proxy all live behind that prefix.
// Signing in on the root page picks the instance by email; it is remembered
// here and the address bar stays at the root.
const INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const STORED_INSTANCE_KEY = 'freellmapi_instance';
const PATH_PREFIX =
  /^\/u\/[a-z0-9-]+(?=\/|$)/.exec(globalThis.window?.location?.pathname ?? '')?.[0] ?? '';

function storedInstance(): string {
  try {
    const name = localStorage.getItem(STORED_INSTANCE_KEY) ?? '';
    return INSTANCE_NAME_RE.test(name) ? name : '';
  } catch { return ''; }
}

export const INSTANCE_PREFIX = PATH_PREFIX || (storedInstance() ? `/u/${storedInstance()}` : '');

export const API_BASE = API_URL || INSTANCE_PREFIX || import.meta.env.BASE_URL.replace(/\/$/, '');
const BASE = API_BASE;

/** Router basename: the prefix in the address bar when there is one, else the build base. */
export const ROUTER_BASENAME = PATH_PREFIX || import.meta.env.BASE_URL;

// Public origin of the backend, for the base URLs shown to the user.
export function apiOrigin(): string {
  if (API_URL) return API_URL;
  return import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}`
    : `${window.location.origin}${INSTANCE_PREFIX}`;
}

// Instances share one origin, so each keeps its own session slot.
function tokenKey(prefix: string): string {
  return prefix ? `freellmapi_dashboard_token:${prefix.slice(3)}` : 'freellmapi_dashboard_token';
}
const TOKEN_KEY = tokenKey(INSTANCE_PREFIX);

/**
 * Sign in. On the root page the login goes to the shared front door, which
 * answers with the instance that owns the email; the session is stored for
 * that instance and the page reloads onto it. Returns false when it reloads.
 */
export async function signIn(payload: { email: string; password: string }): Promise<boolean> {
  const viaDirectory = !API_URL && !PATH_PREFIX;
  const res = viaDirectory
    ? await apiFetchAt<{ token: string; instance?: string }>('', '/api/auth/login', { method: 'POST', body: JSON.stringify(payload) })
    : await apiFetch<{ token: string; instance?: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
  if (viaDirectory && res.instance && INSTANCE_NAME_RE.test(res.instance)) {
    try {
      localStorage.setItem(tokenKey(`/u/${res.instance}`), res.token);
      localStorage.setItem(STORED_INSTANCE_KEY, res.instance);
    } catch { /* ignore */ }
    if (`/u/${res.instance}` !== INSTANCE_PREFIX) {
      window.location.reload();
      return false;
    }
    return true;
  }
  setToken(res.token);
  return true;
}

/** Forget the instance picked on the root page, so the next sign-in can pick another. */
function leaveStoredInstance(): boolean {
  if (PATH_PREFIX || !storedInstance()) return false;
  try { localStorage.removeItem(STORED_INSTANCE_KEY); } catch { /* ignore */ }
  return true;
}

// Dashboard session token (#35). Stored in localStorage; sent as a Bearer on
// every /api request and cleared on a 401.
export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
}
export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export const UNAUTHORIZED_EVENT = 'freellmapi:unauthorized';

// Error thrown by apiFetch on a non-2xx response. Carries the HTTP status and
// the server's machine-readable `error.type` so callers can branch on them.
export interface ApiError extends Error {
  status?: number;
  code?: string;
}

export function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  return apiFetchAt<T>(BASE, path, options);
}

async function apiFetchAt<T>(base: string, path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const headers = new Headers(options?.headers);
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(`${base}${path}`, {
    // `...options` first so an explicit method/body/signal applies, but headers
    // are merged last — otherwise an options.headers would clobber the
    // Content-Type and Authorization we set here.
    ...options,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    // A 401 ends the dashboard session ONLY when it is OUR auth saying so.
    // Discover/probe endpoints deliberately relay an upstream provider's 401
    // ("the endpoint rejected the key") with its status intact; treating those
    // as session-expired signed the operator out every time they tested a bad
    // provider key. The auth middleware and every session 401 carry
    // type 'authentication_error'; upstream relays never do.
    if (res.status === 401 && body.error?.type === 'authentication_error') {
      clearToken();
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    // Surface the HTTP status and the machine-readable error type on the thrown
    // Error so callers can branch on them (e.g. the setup form reveals a code
    // field on a `setup_code_required` 403). `.message` behaviour is unchanged.
    const err = new Error(body.error?.message ?? `HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    err.code = body.error?.type;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  // A 200 whose body isn't JSON means this request never reached the API — the
  // usual cause is a reverse proxy (or static host) serving the dashboard's
  // index.html for /api/* instead of forwarding it to the backend. Without this
  // guard the raw res.json() throws an opaque "Unexpected token '<'", which on
  // the setup/login form surfaces as "sign up page cannot work". Say what's
  // actually wrong. (#257)
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Expected JSON from ${path} but got a non-JSON response. The API isn't reachable at this origin — ` +
      `make sure the backend is running and that /api is forwarded to it, not served as the dashboard's static files.`,
    );
  }
}

export async function logout(): Promise<void> {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  clearToken();
  // Back to the shared sign-in page, so a different user can sign in next.
  if (leaveStoredInstance()) {
    window.location.reload();
    return;
  }
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
}
