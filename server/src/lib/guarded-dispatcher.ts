// An undici Agent whose sockets resolve host names through url-guard's
// connect-time lookup (see createGuardedLookup there for why that closes the
// DNS-rebinding gap that validate-then-fetch leaves open).
//
// Which undici? fetch() on Node's global uses the copy BUNDLED with Node, and a
// dispatcher handed to it should come from the same line. The bundled Agent is
// not importable, but Node keeps the live global dispatcher in the symbol
// registry, so the constructor is taken from it (the same trick
// flushProxyCache() uses to replace the pool). The npm `undici` package is the
// fallback, and it may not be installed in every build (the desktop bundle, a
// pruned image), so nothing here may throw: when no Agent can be built the
// caller keeps the previous behaviour (URL check, then plain fetch).

import { guardedLookup } from './url-guard.js';

interface DispatcherLike {
  close?: () => Promise<void> | void;
}
type AgentCtor = new (options: { connect: { lookup: typeof guardedLookup } }) => DispatcherLike;

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

// undefined: not built yet. A built dispatcher is kept until reset.
let cached: DispatcherLike | undefined;
let warned = false;

function bundledAgentCtor(): AgentCtor | null {
  const current = (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER] as { constructor?: { name?: string } } | undefined;
  // Only a plain Agent takes these options; an env-proxy wrapper would not.
  return current?.constructor?.name === 'Agent' ? (current.constructor as unknown as AgentCtor) : null;
}

async function npmAgentCtor(): Promise<AgentCtor | null> {
  try {
    return (await import('undici')).Agent as unknown as AgentCtor;
  } catch {
    return null;
  }
}

/** The shared guarded dispatcher, or null when this runtime cannot build one. */
export async function getGuardedDispatcher(): Promise<unknown | null> {
  if (cached) return cached;
  const Ctor = bundledAgentCtor() ?? await npmAgentCtor();
  if (!Ctor) {
    if (!warned) {
      warned = true;
      console.warn('[proxy] connect-time address check unavailable (no undici Agent); custom provider URLs are checked before the request only');
    }
    return null;
  }
  cached = new Ctor({ connect: { lookup: guardedLookup } });
  return cached;
}

/** Drop pooled sockets (sleep/wake recovery). In-flight requests finish on the old pool. */
export function resetGuardedDispatcher(): void {
  const old = cached;
  cached = undefined;
  if (old?.close) {
    try {
      void Promise.resolve(old.close()).catch(() => { /* already closed */ });
    } catch { /* already closed */ }
  }
}
