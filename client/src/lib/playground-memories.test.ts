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
    expect(msg).toContain('durable facts')
    expect(msg).toContain('- Prefers Romanian')
    expect(msg).toContain('- Works on FreeLLMAPI')
  })

  it('returns empty when there is nothing to inject', () => {
    expect(memoryContextMessage([])).toBe('')
    expect(memoryContextMessage([{ content: '  ' }])).toBe('')
  })

  it('parses a bare JSON array and a fenced one', () => {
    expect(parseExtractedMemories('["Likes dark mode","Uses zsh"]')).toEqual([
      'Likes dark mode',
      'Uses zsh',
    ])
    expect(parseExtractedMemories('Sure.\n```json\n["A"]\n```')).toEqual(['A'])
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
