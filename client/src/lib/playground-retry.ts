// Regenerate and edit-and-resend for the Playground transcript, kept pure so
// the rules are unit-tested without the page. Both end the same way: the
// transcript is cut back to a user message and the reply is produced again
// from there, so nothing after the cut survives (the old answer is replaced,
// not kept as a sibling).

import type { ChatMessage } from '@/lib/playground-conversations'

/** Longest question text sent to web search / recall when it is not freshly typed. */
const MAX_QUERY_CHARS = 500

/**
 * The transcript up to and including the last user message — what a
 * regenerated reply is produced from. Null when there is no user message.
 */
export function regenerationBase(messages: ChatMessage[]): ChatMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages.slice(0, i + 1)
  }
  return null
}

/**
 * Whether message `index` carries the Regenerate / Try again action: only the
 * final message, only a finished assistant reply (or its error bubble).
 */
export function canRegenerate(messages: ChatMessage[], index: number): boolean {
  const message = messages[index]
  return index === messages.length - 1
    && message?.role === 'assistant'
    && !message.streaming
    && regenerationBase(messages) !== null
}

/**
 * The transcript after editing the user message at `index`: everything before
 * it, then the edited message (its images are kept). Null when `index` is not a
 * user message or the new text is blank.
 */
export function editedTranscript(messages: ChatMessage[], index: number, text: string): ChatMessage[] | null {
  const original = messages[index]
  const content = text.trim()
  if (!original || original.role !== 'user' || !content) return null
  return [...messages.slice(0, index), { ...original, content }]
}

/** The text a search or recall lookup should use for a message that was not just typed. */
export function lookupText(message: ChatMessage): string {
  return message.content.slice(0, MAX_QUERY_CHARS)
}
