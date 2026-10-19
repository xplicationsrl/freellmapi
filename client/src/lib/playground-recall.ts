// Playground cross-chat recall: API wrapper + the system message that injects
// relevant past turns into a new request so answers can come from what was
// already discussed, not only from extracted fact bullets.

import { apiFetch } from './api'

export interface RecallSnippet {
  conversationId: number
  title: string
  role: 'user' | 'assistant'
  content: string
}

export interface RecallResponse {
  snippets: RecallSnippet[]
}

export function recallConversations(input: {
  query: string
  excludeConversationId?: number | null
  limit?: number
}): Promise<RecallResponse> {
  return apiFetch<RecallResponse>('/api/conversations/recall', {
    method: 'POST',
    body: JSON.stringify({
      query: input.query,
      excludeConversationId: input.excludeConversationId ?? null,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
  })
}

/**
 * System message carrying past-chat excerpts. Empty when there is nothing to
 * recall — the caller skips injection in that case so we do not claim access
 * to history we did not find.
 */
export function conversationRecallMessage(snippets: readonly RecallSnippet[]): string {
  if (snippets.length === 0) return ''

  const blocks = snippets.map((snippet, index) => {
    const title = snippet.title.trim() || 'Untitled chat'
    const who = snippet.role === 'user' ? 'User' : 'Assistant'
    return `${index + 1}. From "${title}" (${who}):\n${snippet.content}`
  })

  return [
    'You can recall relevant excerpts from this account\'s earlier Playground chats.',
    'Use them when they answer the user\'s question. Prefer these excerpts over claiming you lack prior context.',
    'Never say you cannot access past chats or that every session is a blank slate when excerpts are listed below.',
    'Do not invent details that are not in the excerpts or the current conversation.',
    '',
    'Relevant excerpts from earlier chats:',
    ...blocks,
  ].join('\n')
}
