import crypto from 'crypto';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString } from './content.js';

// Sticky sessions: track which model served each "session"
// Key: hash of first user message → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

// #797: per-session memory of the last assistant turn's thinking trace.
// DeepSeek thinking models on OpenCode Zen 400 on a follow-up turn unless the
// prior `reasoning_content` is replayed; opencode (and other AI-SDK clients)
// strip the field when re-serializing history, so the proxy restores what it
// itself returned last turn. Non-thinking sessions never record an entry.
// The trace is stored WITH the model key that produced it: a remembered trace
// is only ever replayed to that same platform+model, so a session that fails
// over (or auto-routes elsewhere on the next turn) never carries one model's
// thinking into another provider's payload.
const reasoningMemory = new Map<string, { reasoning: string; modelKey: string; lastUsed: number }>();
const REASONING_TTL_MS = 30 * 60 * 1000; // 30 min, matching sticky sessions

// Platforms that reject an assistant turn WITHOUT `reasoning_content` once the
// conversation is in thinking mode, i.e. where the field has to be present on
// every assistant message and older turns need an empty-string filler. Only
// OpenCode Zen is on record for this (the DeepSeek thinking semantics behind
// #255/#797); everywhere else only the turn we actually have a trace for is
// touched, so no other provider's bytes change.
const PLATFORMS_REQUIRING_REASONING_ECHO = new Set(['opencode']);

export function rememberReasoning(sessionKey: string | undefined, modelKey: string, reasoning: string) {
  if (!sessionKey || !reasoning) return;
  reasoningMemory.set(sessionKey, { reasoning, modelKey, lastUsed: Date.now() });
  if (reasoningMemory.size > 500) {
    const now = Date.now();
    for (const [key, entry] of reasoningMemory) {
      if (now - entry.lastUsed > REASONING_TTL_MS) reasoningMemory.delete(key);
    }

    // Hard cap: traces are far bigger than a sticky entry, so an all-fresh map
    // must not grow without bound. Evict oldest by lastUsed, as setStickyModel does.
    if (reasoningMemory.size > 1000) {
      const entries = [...reasoningMemory.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const toEvict = reasoningMemory.size - 1000;
      for (let i = 0; i < toEvict; i++) reasoningMemory.delete(entries[i][0]);
    }
  }
}

// The remembered trace for this session, or undefined when there is none, it
// expired, or it came from a different model than the one about to be called.
// An expired entry is dropped on read rather than left for the size sweep.
export function clearReasoningMemory() {
  reasoningMemory.clear();
  stickySessionMap.clear();
}

export function rememberedReasoningFor(sessionKey: string, modelKey: string): string | undefined {
  if (!sessionKey) return undefined;
  const entry = reasoningMemory.get(sessionKey);
  if (!entry) return undefined;
  if (Date.now() - entry.lastUsed > REASONING_TTL_MS) {
    reasoningMemory.delete(sessionKey);
    return undefined;
  }
  return entry.modelKey === modelKey ? entry.reasoning : undefined;
}

// Put the remembered trace back on the newest assistant turn that lost it.
// Returns a NEW array (with new objects for the messages it changes) whenever
// it changes anything — the caller's `messages` are what handoff recording,
// logging, compression and the response cache already saw, and must not move
// under them. Returns the input untouched when there is nothing to restore.
export function restoreSessionReasoning(messages: ChatMessage[], reasoning: string, platform: string): ChatMessage[] {
  // Older assistant turns get "" — DeepSeek requires the field on every
  // assistant message, and an empty string satisfies it (see opencode issue
  // #24104). Only for platforms that actually enforce that; elsewhere just the
  // one turn we have a real trace for is touched.
  const fillOlderTurns = PLATFORMS_REQUIRING_REASONING_ECHO.has(platform);
  let restored: ChatMessage[] | undefined;
  let restoredLatest = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    // The client kept the field — nothing was dropped, leave it alone.
    if (typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0) continue;
    restored ??= [...messages];
    restored[i] = { ...m, reasoning_content: restoredLatest ? '' : reasoning };
    if (!restoredLatest && !fillOlderTurns) break;
    restoredLatest = true;
  }
  return restored ?? messages;
}

export function getSessionKey(messages: ChatMessage[], sessionIdHeader?: string, strategyKey?: string): string {
  if (sessionIdHeader) {
    return strategyKey ? `hdr:${sessionIdHeader}::${strategyKey}` : `hdr:${sessionIdHeader}`;
  }

  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return '';
  const text = contentToString(firstUser.content ?? '');
  if (!text) return '';
  const payload = strategyKey ? `${text}::${strategyKey}` : text;
  return crypto.createHash('sha1').update(payload).digest('hex');
}

export function getStickyModel(messages: ChatMessage[], sessionIdHeader?: string, strategyKey?: string): number | undefined {
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = getSessionKey(messages, sessionIdHeader, strategyKey);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

export function setStickyModel(messages: ChatMessage[], modelDbId: number, sessionIdHeader?: string, strategyKey?: string) {
  const key = getSessionKey(messages, sessionIdHeader, strategyKey);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup old entries
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }

    // Hard cap: if still over 1000 after pruning expired entries, evict oldest by lastUsed
    if (stickySessionMap.size > 1000) {
      const entries = [...stickySessionMap.entries()].sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed
      );
      const toEvict = stickySessionMap.size - 1000;
      for (let i = 0; i < toEvict; i++) {
        stickySessionMap.delete(entries[i][0]);
      }
    }
  }
}
