import { describe, expect, it } from 'vitest'
import { parseSkill } from '../../scripts/skill-front-matter.mjs'

describe('parseSkill', () => {
  it('reads a one-line name and description and returns the body without the front matter', () => {
    const parsed = parseSkill('x', '---\nname: interview-me\ndescription: Asks one question at a time.\n---\n\n# Interview\nBody.\n')
    expect(parsed).toEqual({ name: 'interview-me', description: 'Asks one question at a time.', body: '# Interview\nBody.\n' })
  })

  it('joins a block-scalar description into one line and stops at the next key', () => {
    const text = '---\nname: humanizer\ndescription: |\n  Rewrite AI-sounding text.\n  Use when editing prose.\nlicense: MIT\nmetadata:\n  version: "3.1.0"\n---\n# Humanizer\n'
    const parsed = parseSkill('h', text)
    expect(parsed.description).toBe('Rewrite AI-sounding text. Use when editing prose.')
    expect(parsed.name).toBe('humanizer')
    expect(parsed.body).toBe('# Humanizer\n')
  })

  it('handles folded scalars, quoted values and Windows line endings', () => {
    const parsed = parseSkill('f', '---\r\nname: "quoted"\r\ndescription: >-\r\n  folded\r\n  text\r\n---\r\nbody')
    expect(parsed).toMatchObject({ name: 'quoted', description: 'folded text', body: 'body' })
  })

  it('refuses a file with no front matter, or without a name or description', () => {
    expect(() => parseSkill('a', '# just markdown')).toThrow('no front matter')
    expect(() => parseSkill('b', '---\nname: only-name\n---\nbody')).toThrow('lacks name or description')
  })
})
