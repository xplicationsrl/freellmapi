import { describe, it, expect } from 'vitest'
import { conversationToMarkdown, exportDate, exportFilename } from '@/lib/conversation-export'
import type { ChatMessage } from '@/lib/playground-conversations'

const labels = { you: 'You', assistant: 'Assistant' }
const day = new Date(2026, 9, 20, 15, 30)

describe('conversationToMarkdown', () => {
  it('writes a titled document with one section per message, naming the model that answered', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: 'It is **4**.', meta: { platform: 'groq', model: 'llama-3.3-70b' } },
    ]
    expect(conversationToMarkdown({ title: 'Math', model: 'auto', messages }, labels, day)).toBe(
      '# Math\n\n> model: auto · 2026-10-20\n\n## You\n\nWhat is 2+2?\n\n## Assistant · groq/llama-3.3-70b\n\nIt is **4**.\n',
    )
  })

  it('keeps code fences intact, marks images, errors and thumbs, and skips empty messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'look', images: ['data:image/png;base64,AA', 'data:image/png;base64,BB'] },
      { role: 'assistant', content: 'Here:\n```js\nconst a = 1\n```', feedback: 'up' },
      { role: 'assistant', content: 'upstream\nexploded', isError: true },
      { role: 'assistant', content: '   ' },
    ]
    const md = conversationToMarkdown({ title: '', model: null, messages }, labels, day)
    expect(md).toContain('# Assistant\n\n> 2026-10-20')
    expect(md).toContain('## You\n\n*[image]* *[image]*\n\nlook')
    expect(md).toContain('```js\nconst a = 1\n```\n\n👍')
    expect(md).toContain('> ⚠ upstream\n> exploded')
    expect(md.match(/## /g)).toHaveLength(3)
    expect(md.endsWith('\n')).toBe(true)
    expect(md).not.toContain('data:image')
  })
})

describe('exportFilename', () => {
  it('makes an ASCII slug with the date, whatever the title language', () => {
    expect(exportFilename('Ce fac mâine? Plănuiește-mi ziua!', day)).toBe('ce-fac-maine-planuieste-mi-ziua-2026-10-20.md')
    expect(exportFilename('日本語のタイトル', day)).toBe('conversation-2026-10-20.md')
    expect(exportFilename('  ///  ', day)).toBe('conversation-2026-10-20.md')
  })

  it('caps a very long title', () => {
    const name = exportFilename('word '.repeat(60), day)
    expect(name.length).toBeLessThanOrEqual(60 + '-2026-10-20.md'.length)
    expect(name.startsWith('word-word')).toBe(true)
  })
})

describe('exportDate', () => {
  it('zero-pads month and day', () => {
    expect(exportDate(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})
