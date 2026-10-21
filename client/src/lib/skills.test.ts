import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ACTIVE_SKILLS, LARGE_SKILL_CONTEXT_TOKENS, MAX_ACTIVE_SKILLS, activeTokens, formatTokens, loadSkillBody, loadSkillIndex, matchedTriggers,
  normalizeForMatch, readActiveSkills, sanitizeActive, skillsSystemMessage, suggestSkills, toggleSkill, type SkillIndex,
} from '@/lib/skills'
import { SKILL_TRIGGERS } from '@/lib/skill-triggers'

const index: SkillIndex = {
  sources: [{ id: 'agent-skills', name: 'Agent Skills', author: 'A', repo: 'r', commit: 'c', license: 'MIT' }],
  skills: [
    { id: 'security-and-hardening', name: 'security-and-hardening', description: 'd', tokens: 4000, source: 'agent-skills' },
    { id: 'interview-me', name: 'interview-me', description: 'd', tokens: 3000, source: 'agent-skills' },
  ],
}
const known = new Set(Object.keys(SKILL_TRIGGERS))

describe('toggleSkill', () => {
  it('adds, removes, and refuses a fourth', () => {
    expect(toggleSkill([], 'a')).toEqual(['a'])
    expect(toggleSkill(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggleSkill(['a', 'b', 'c'], 'd')).toBeNull()
    expect(toggleSkill(['a', 'b', 'c'], 'c')).toEqual(['a', 'b'])
    expect(MAX_ACTIVE_SKILLS).toBe(3)
  })
})

describe('sanitizeActive', () => {
  it('drops unknown ids, duplicates, non-strings and anything past the limit', () => {
    const ids = new Set(['a', 'b', 'c', 'd'])
    expect(sanitizeActive(['a', 'zzz', 'a', 7, 'b', 'c', 'd'], ids)).toEqual(['a', 'b', 'c'])
    expect(sanitizeActive('nope', ids)).toEqual([])
    expect(sanitizeActive(null, ids)).toEqual([])
  })
})

describe('activeTokens', () => {
  it('sums the estimates of the active skills, and ignores ids it does not know', () => {
    expect(activeTokens(['security-and-hardening', 'interview-me', 'ghost'], index)).toBe(7000)
    expect(activeTokens(['interview-me'], null)).toBe(0)
    expect(LARGE_SKILL_CONTEXT_TOKENS).toBeGreaterThan(5000)
  })
})

describe('formatTokens', () => {
  it('shows thousands with one decimal and drops a trailing .0', () => {
    expect(formatTokens(820)).toBe('820')
    expect(formatTokens(3400)).toBe('3.4k')
    expect(formatTokens(5000)).toBe('5k')
    expect(formatTokens(12345)).toBe('12.3k')
  })
})

describe('skillsSystemMessage', () => {
  it('tells the model it has no tools, then lists each skill under its name', () => {
    const text = skillsSystemMessage([{ name: 'interview-me', body: '\n# Interview\nAsk one question.\n' }, { name: 'tdd', body: 'Red, green.' }])
    expect(text).toContain('cannot run commands')
    expect(text).toContain('## Skill: interview-me\n\n# Interview\nAsk one question.')
    expect(text.indexOf('## Skill: interview-me')).toBeLessThan(text.indexOf('## Skill: tdd'))
  })
})

describe('matching', () => {
  it('ignores case and diacritics', () => {
    expect(normalizeForMatch('Securitatea Parolelor și ȘTIRI')).toBe('securitatea parolelor si stiri')
  })

  it('matches by word start, and whole-word only for "=" keywords', () => {
    expect(matchedTriggers('securitatea aplicatiei', ['securitate'])).toEqual(['securitate'])
    expect(matchedTriggers('un circuit electric', ['=ci'])).toEqual([])
    expect(matchedTriggers('rulez ci pe main', ['=ci'])).toEqual(['=ci'])
    expect(matchedTriggers('nu pot afla', ['bug'])).toEqual([])
  })
})

describe('suggestSkills', () => {
  it('suggests from Romanian and English phrasing', () => {
    expect(suggestSkills('Am o problemă de securitate: parolele sunt în clar', known)[0].id).toBe('security-and-hardening')
    expect(suggestSkills('there is a crash with a stack trace in production', known).map(s => s.id)).toContain('debugging-and-error-recovery')
    expect(suggestSkills('vreau sa construiesc o aplicatie de rezervari', known)[0].id).toBe('interview-me')
  })

  it('ranks the skill with more matches first, honours the limit and the exclusions', () => {
    const text = 'review pe pull request: vulnerabilitati xss si injection in endpoint'
    const result = suggestSkills(text, known, { limit: 2 })
    expect(result[0].id).toBe('security-and-hardening')
    expect(result).toHaveLength(2)
    expect(suggestSkills(text, known, { exclude: ['security-and-hardening'] }).map(s => s.id)).not.toContain('security-and-hardening')
  })

  it('suggests the humanizer for text that should stop sounding like AI', () => {
    expect(suggestSkills('Rescrie textul ăsta, sună a AI și vreau să fie mai natural', known)[0].id).toBe('humanizer')
    expect(suggestSkills('this draft sounds like ai, please make it more natural', known)[0].id).toBe('humanizer')
    expect(suggestSkills('how do I humanize this paragraph', known).map(s => s.id)).toContain('humanizer')
  })

  it('says nothing for short text, small talk, or ids that are not offered', () => {
    expect(suggestSkills('salut', known)).toEqual([])
    expect(suggestSkills('ce mai faci astazi prietene', known)).toEqual([])
    expect(suggestSkills('o problemă de securitate gravă', new Set(['interview-me']))).toEqual([])
  })

  it('has triggers for every shipped skill id', async () => {
    const ids = (await import('../../public/skills/index.json')).default.skills.map((s: { id: string }) => s.id)
    for (const id of ids) expect(SKILL_TRIGGERS, id).toHaveProperty(id)
  })
})

describe('loading', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches a skill once and retries after a failure', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => (++calls === 1 ? new Response('no', { status: 404 }) : new Response('# Body'))))
    await expect(loadSkillBody('x-once')).rejects.toThrow('HTTP 404')
    expect(await loadSkillBody('x-once')).toBe('# Body')
    expect(await loadSkillBody('x-once')).toBe('# Body')
    expect(calls).toBe(2)
  })

  it('reads the index from the skills folder', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(index)))
    vi.stubGlobal('fetch', fetchMock)
    expect((await loadSkillIndex()).skills).toHaveLength(2)
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/skills\/index\.json$/)
  })
})

describe('default skills', () => {
  afterEach(() => vi.unstubAllGlobals())

  const store = (value: string | null) => vi.stubGlobal('localStorage', { getItem: () => value })

  it('are on until a selection was saved, and stay within the limit', async () => {
    store(null)
    expect(readActiveSkills()).toEqual(DEFAULT_ACTIVE_SKILLS)
    expect(DEFAULT_ACTIVE_SKILLS.length).toBeLessThanOrEqual(MAX_ACTIVE_SKILLS)
    const shipped = (await import('../../public/skills/index.json')).default.skills as Array<{ id: string; tokens: number }>
    for (const id of DEFAULT_ACTIVE_SKILLS) expect(shipped.map(s => s.id), id).toContain(id)
    const total = shipped.filter(s => DEFAULT_ACTIVE_SKILLS.includes(s.id)).reduce((n, s) => n + s.tokens, 0)
    expect(total).toBeLessThan(LARGE_SKILL_CONTEXT_TOKENS / 4)
  })

  it('stay off once the person emptied the selection', () => {
    store('[]')
    expect(readActiveSkills()).toEqual([])
    store('["humanizer"]')
    expect(readActiveSkills()).toEqual(['humanizer'])
  })
})
