// Pure helpers for Playground cross-chat recall: turn extraction, query
// tokenisation, and ranking past messages so a new chat can answer from what
// was already discussed (e.g. "cum mă cheamă?" → earlier "Mă numesc …").

export const DEFAULT_RECALL_LIMIT = 6;
export const MAX_RECALL_CONTENT_CHARS = 400;
export const MAX_RECALL_CANDIDATES = 400;

export interface RecallTurnInput {
  conversationId: number;
  title: string;
  role: 'user' | 'assistant';
  content: string;
  updatedAtMs: number;
  turnIndex: number;
}

export interface RecallSnippet {
  conversationId: number;
  title: string;
  role: 'user' | 'assistant';
  content: string;
  score: number;
}

/** Strip a stored message list down to plain searchable turns. */
export function turnsFromMessages(
  messages: readonly { role?: unknown; content?: unknown }[],
): { turnIndex: number; role: 'user' | 'assistant'; content: string }[] {
  const out: { turnIndex: number; role: 'user' | 'assistant'; content: string }[] = [];
  messages.forEach((msg, turnIndex) => {
    if (msg.role !== 'user' && msg.role !== 'assistant') return;
    if (typeof msg.content !== 'string') return;
    const content = msg.content.trim();
    if (!content) return;
    out.push({ turnIndex, role: msg.role, content });
  });
  return out;
}

/** Lowercase alphanumeric tokens; keeps diacritic-folded Latin letters. */
export function tokenizeRecallQuery(text: string): string[] {
  const folded = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  const parts = folded.match(/[a-z0-9]{2,}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

const IDENTITY_QUERY_HINTS = new Set([
  'cheama',
  'nume',
  'numesc',
  'numele',
  'cum',
  'name',
  'called',
  'call',
  'who',
]);

const IDENTITY_CONTENT_HINTS = [
  'ma numesc',
  'mă numesc',
  'numele meu',
  'my name is',
  'i am called',
  'i\'m called',
  'call me',
];

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function isIdentityQuery(tokens: readonly string[]): boolean {
  return tokens.some(t => IDENTITY_QUERY_HINTS.has(t));
}

function contentLooksLikeIdentity(foldedContent: string): boolean {
  return IDENTITY_CONTENT_HINTS.some(hint => foldedContent.includes(fold(hint)));
}

function truncateContent(content: string): string {
  if (content.length <= MAX_RECALL_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_RECALL_CONTENT_CHARS - 1).trimEnd()}…`;
}

/**
 * Score one past turn against the user's question. Higher is better.
 * Combines token overlap (content + title), identity boosts, user-turn bias,
 * and mild recency so recent chats win ties.
 */
export function scoreRecallTurn(
  queryTokens: readonly string[],
  turn: RecallTurnInput,
  nowMs: number = Date.now(),
): number {
  if (queryTokens.length === 0) return 0;

  const foldedContent = fold(turn.content);
  const foldedTitle = fold(turn.title);
  let overlap = 0;
  for (const token of queryTokens) {
    if (foldedContent.includes(token)) overlap += 3;
    if (foldedTitle.includes(token)) overlap += 2;
  }
  if (overlap === 0 && !(isIdentityQuery(queryTokens) && contentLooksLikeIdentity(foldedContent))) {
    return 0;
  }

  let score = overlap;
  if (isIdentityQuery(queryTokens) && contentLooksLikeIdentity(foldedContent)) {
    score += 12;
  }
  if (turn.role === 'user') score += 1.5;

  const ageMs = Math.max(0, nowMs - turn.updatedAtMs);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  score += Math.max(0, 2 - Math.min(ageDays, 14) / 7);

  return score;
}

/**
 * Rank candidate turns and return the top snippets, at most one strong hit
 * per conversation unless the query still needs more slots.
 */
export function rankRecallSnippets(
  query: string,
  turns: readonly RecallTurnInput[],
  opts: { limit?: number; nowMs?: number } = {},
): RecallSnippet[] {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_RECALL_LIMIT, 1), 12);
  const nowMs = opts.nowMs ?? Date.now();
  const tokens = tokenizeRecallQuery(query);
  if (tokens.length === 0 || turns.length === 0) return [];

  const scored = turns
    .map(turn => ({
      turn,
      score: scoreRecallTurn(tokens, turn, nowMs),
    }))
    .filter(row => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.turn.updatedAtMs - a.turn.updatedAtMs;
    });

  const out: RecallSnippet[] = [];
  const usedConversations = new Set<number>();

  // First pass: best turn per conversation.
  for (const row of scored) {
    if (out.length >= limit) break;
    if (usedConversations.has(row.turn.conversationId)) continue;
    usedConversations.add(row.turn.conversationId);
    out.push({
      conversationId: row.turn.conversationId,
      title: row.turn.title,
      role: row.turn.role,
      content: truncateContent(row.turn.content),
      score: row.score,
    });
  }

  // Second pass: fill remaining slots with more turns if needed.
  if (out.length < limit) {
    for (const row of scored) {
      if (out.length >= limit) break;
      const already = out.some(
        s => s.conversationId === row.turn.conversationId
          && s.content === truncateContent(row.turn.content),
      );
      if (already) continue;
      out.push({
        conversationId: row.turn.conversationId,
        title: row.turn.title,
        role: row.turn.role,
        content: truncateContent(row.turn.content),
        score: row.score,
      });
    }
  }

  return out;
}
