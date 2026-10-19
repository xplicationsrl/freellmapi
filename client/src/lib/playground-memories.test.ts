import { describe, expect, it } from 'vitest'
import {
  filterNewMemories,
  memoryContextMessage,
  normalizeMemoryContent,
  parseExtractedMemories,
} from './playground-memories'

describe('playground memories helpers', () => {
  it('builds an injected system message from facts', () => {
    const msg = memoryContextMessage([
      { content: 'Prefers Romanian' },
      { content: 'Works on FreeLLMAPI' },
    ])
    expect(msg).toContain('durable facts auto-saved')
    expect(msg).toContain('Never claim you lack long-term memory')
    expect(msg).toContain('- Prefers Romanian')
    expect(msg).toContain('- Works on FreeLLMAPI')
  })

  it('still injects a preamble when there are no facts yet', () => {
    const empty = memoryContextMessage([])
    expect(empty).toContain('durable facts auto-saved')
    expect(empty).toContain('Stored facts: (none yet)')
    expect(memoryContextMessage([{ content: '  ' }])).toContain('(none yet)')
  })

  it('parses a bare JSON array and a fenced one', () => {
    expect(parseExtractedMemories('["Likes dark mode","Uses zsh"]')).toEqual([
      'Likes dark mode',
      'Uses zsh',
    ])
    expect(parseExtractedMemories('Sure.\n```json\n["A"]\n```')).toEqual(['A'])
  })

  it('strips think tags before parsing extraction JSON', () => {
    expect(parseExtractedMemories('<think>hmm</think>["Owns Xplication"]')).toEqual([
      'Owns Xplication',
    ])
  })

  it('drops junk and duplicates from extraction output', () => {
    expect(parseExtractedMemories('not json')).toEqual([])
    expect(parseExtractedMemories('["Same","same",123,""]')).toEqual(['Same'])
  })

  it('filters candidates already stored', () => {
    expect(filterNewMemories(
      ['Lives in Bucharest', 'Prefers TypeScript', 'lives in bucharest'],
      [{ content: 'Lives in Bucharest' }],
    )).toEqual(['Prefers TypeScript'])
  })

  it('normalizes whitespace and caps length', () => {
    expect(normalizeMemoryContent('  hello   world  ')).toBe('hello world')
    expect(normalizeMemoryContent('x'.repeat(600)).length).toBe(500)
  })
})
