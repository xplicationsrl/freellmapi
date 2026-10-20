import { describe, it, expect } from 'vitest'
import { canRegenerate, editedTranscript, lookupText, regenerationBase } from '@/lib/playground-retry'
import type { ChatMessage } from '@/lib/playground-conversations'

const u = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'user', content, ...extra })
const a = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'assistant', content, ...extra })

describe('regenerationBase', () => {
  it('cuts back to the last user message, dropping the reply after it', () => {
    const chat = [u('one'), a('first'), u('two'), a('second')]
    expect(regenerationBase(chat)).toEqual([u('one'), a('first'), u('two')])
  })

  it('drops an error bubble the same way', () => {
    const chat = [u('one'), a('boom', { isError: true })]
    expect(regenerationBase(chat)).toEqual([u('one')])
  })

  it('is null when there is no user message, and does not mutate its input', () => {
    expect(regenerationBase([])).toBeNull()
    expect(regenerationBase([a('orphan')])).toBeNull()
    const chat = [u('one'), a('first')]
    regenerationBase(chat)
    expect(chat).toHaveLength(2)
  })
})

describe('canRegenerate', () => {
  const chat = [u('one'), a('first'), u('two'), a('second')]

  it('allows only the last message, and only when it is an assistant reply', () => {
    expect(canRegenerate(chat, 3)).toBe(true)
    expect(canRegenerate(chat, 1)).toBe(false)
    expect(canRegenerate(chat, 2)).toBe(false)
    expect(canRegenerate([u('one')], 0)).toBe(false)
  })

  it('offers it on an error bubble but not on a reply that is still streaming', () => {
    expect(canRegenerate([u('x'), a('failed', { isError: true })], 1)).toBe(true)
    expect(canRegenerate([u('x'), a('partial', { streaming: true })], 1)).toBe(false)
  })
})

describe('editedTranscript', () => {
  const chat = [u('one'), a('first'), u('two', { images: ['data:image/png;base64,AA'] }), a('second')]

  it('replaces the edited message and drops everything after it', () => {
    expect(editedTranscript(chat, 0, ' uno ')).toEqual([u('uno')])
  })

  it('keeps the images of the edited message', () => {
    expect(editedTranscript(chat, 2, 'dos')).toEqual([
      u('one'), a('first'), u('dos', { images: ['data:image/png;base64,AA'] }),
    ])
  })

  it('refuses an assistant message, a missing index and blank text', () => {
    expect(editedTranscript(chat, 1, 'x')).toBeNull()
    expect(editedTranscript(chat, 9, 'x')).toBeNull()
    expect(editedTranscript(chat, 0, '   ')).toBeNull()
  })
})

describe('lookupText', () => {
  it('caps a long message (e.g. one with an inlined file) for search and recall', () => {
    expect(lookupText(u('short'))).toBe('short')
    expect(lookupText(u('x'.repeat(2000)))).toHaveLength(500)
  })
})
