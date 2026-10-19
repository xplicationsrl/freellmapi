import { describe, expect, it } from 'vitest'
import { conversationRecallMessage } from './playground-recall'

describe('playground recall helpers', () => {
  it('returns empty when there are no snippets', () => {
    expect(conversationRecallMessage([])).toBe('')
  })

  it('builds a system message from past-chat excerpts', () => {
    const msg = conversationRecallMessage([
      {
        conversationId: 1,
        title: 'Ma numesc Bala Alexandru',
        role: 'user',
        content: 'Ma numesc Bala Alexandru',
      },
      {
        conversationId: 2,
        title: '',
        role: 'assistant',
        content: 'Got it.',
      },
    ])
    expect(msg).toContain('earlier Playground chats')
    expect(msg).toContain('Never say you cannot access past chats')
    expect(msg).toContain('From "Ma numesc Bala Alexandru" (User)')
    expect(msg).toContain('Ma numesc Bala Alexandru')
    expect(msg).toContain('From "Untitled chat" (Assistant)')
  })
})
