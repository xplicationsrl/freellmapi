// Playground cross-chat memory: shapes, API wrappers, and the pure helpers that
// build the injected system message and parse an extraction reply.
//
// Memories are per dashboard account. The page injects them into every request
// when the toggle is on, and may ask the router to propose new facts after an
// exchange. Storage lives on /api/memories; extraction is a normal /v1 call.

import { apiFetch } from './api'

export interface Memory {
  id: number
  content: string
  createdAt: number
  updatedAt: number
}

/** localStorage key: whether Playground injects + extracts memories. */
export const MEMORY_ENABLED_KEY = 'playground.memory'

export const MAX_MEMORY_LEN = 500

export function readMemoryEnabled(): boolean {
  try {
    const raw = localStorage.getItem(MEMORY_ENABLED_KEY)
    // Default on — ChatGPT-style: memory works until you turn it off.
    if (raw === null) return true
    return raw === '1'
  } catch {
    return true
  }
}

export function writeMemoryEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(MEMORY_ENABLED_KEY, enabled ? '1' : '0')
  } catch {
    // Private-mode / quota failures are not worth breaking a chat over.
  }
}

export function listMemories(): Promise<Memory[]> {
  return apiFetch<Memory[]>('/api/memories')
}

export function createMemory(content: string): Promise<Memory> {
  return apiFetch<Memory>('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
}

export function updateMemory(id: number, content: string): Promise<Memory> {
  return apiFetch<Memory>(`/api/memories/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
}

export function deleteMemory(id: number): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/memories/${id}`, { method: 'DELETE' })
}

/**
 * System message that carries remembered facts into a Playground request.
 * Always non-empty: even with no facts yet, the model must know memory exists
 * so it does not fall back to the generic "I have no long-term memory" refusal.
 */
export function memoryContextMessage(memories: readonly { content: string }[]): string {
  const lines = memories
    .map(m => m.content.trim())
    .filter(Boolean)

  const preamble = [
    'You have durable cross-chat memory for this Playground account.',
    'Never claim you lack long-term memory, cannot access past chats, or that every session is a blank slate — this product stores facts across chats.',
    'When the user asks what you know about them, their businesses, projects, or preferences, answer from the stored facts below.',
    'If the list is empty, say you do not have stored facts yet (not that you lack a memory system) and invite them to share what to remember.',
    'Use these facts when relevant. Do not recite the full list unless asked.',
  ]

  if (lines.length === 0) {
    return [...preamble, '', 'Stored facts: (none yet)'].join('\n')
  }
  return [
    ...preamble,
    '',
    'Stored facts:',
    ...lines.map(line => `- ${line}`),
  ].join('\n')
}

/** Collapse whitespace and cap length the same way the server does. */
export function normalizeMemoryContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, MAX_MEMORY_LEN)
}

/** Drop model thinking wrappers so a trailing JSON array is still findable. */
function stripModelChrome(raw: string): string {
  return raw
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, '')
    .trim()
}

/**
 * Pull a JSON array of short fact strings out of a model reply. Tolerates
 * fenced code blocks and prose around the array; anything that is not a
 * non-empty string is dropped.
 */
export function parseExtractedMemories(raw: string): string[] {
  const text = stripModelChrome(raw)
  if (!text) return []

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] ?? text).trim()

  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start < 0 || end <= start) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const seen = new Set<string>()
  const out: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string') continue
    const normalized = normalizeMemoryContent(item)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

/**
 * Drop candidates that already exist (case-insensitive). Used before POSTing
 * extracted facts so a chat that re-mentions a known preference stays quiet.
 */
export function filterNewMemories(
  candidates: readonly string[],
  existing: readonly { content: string }[],
): string[] {
  const known = new Set(existing.map(m => m.content.trim().toLowerCase()).filter(Boolean))
  const out: string[] = []
  for (const candidate of candidates) {
    const normalized = normalizeMemoryContent(candidate)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (known.has(key)) continue
    known.add(key)
    out.push(normalized)
  }
  return out
}

/** Prompt that asks the model for new durable facts only. */
export function memoryExtractPrompt(
  existing: readonly { content: string }[],
  latestExchange: { user: string; assistant: string },
): string {
  const existingBlock = existing.length === 0
    ? '(none yet)'
    : existing.map(m => `- ${m.content}`).join('\n')

  return [
    'You maintain a durable memory store for a chat product.',
    'Given the latest exchange and the memories already stored, return ONLY a JSON array of NEW facts worth remembering across future chats.',
    'Remember: identity, preferences, businesses/companies (name, industry, products, clients), ongoing projects, constraints, relationships, stable goals.',
    'When the user is teaching you about a company or asking you to learn/remember something, extract concrete facts even if the assistant reply was mostly acknowledgements.',
    'Skip: ephemeral task details, one-off questions, secrets (passwords, API keys), anything already covered below.',
    'Each item: one short factual sentence, max 200 characters.',
    'If nothing new is worth remembering, return [].',
    '',
    'Existing memories:',
    existingBlock,
    '',
    'Latest user message:',
    latestExchange.user.slice(0, 4000),
    '',
    'Latest assistant reply:',
    latestExchange.assistant.slice(0, 4000),
  ].join('\n')
}
