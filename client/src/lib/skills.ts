// The Agent Skills library offered in the Playground
// (https://github.com/addyosmani/agent-skills, MIT, by Addy Osmani).
//
// A skill is a Markdown document of working guidelines. Turning one on adds it
// to the conversation as system context, so the model follows it. The copies
// live in public/skills/ (refreshed with scripts/sync-skills.mjs) and are
// fetched on first use, so nothing is paid for until the picker opens or a
// skill is sent.
//
// Free-tier models have small contexts, so at most MAX_ACTIVE_SKILLS can be on
// at once and the cost is shown in tokens (about 4 characters each).

import { SKILL_TRIGGERS } from '@/lib/skill-triggers'

export const MAX_ACTIVE_SKILLS = 3
/** Above this many tokens of skills a small free model may refuse or cut the request. */
export const LARGE_SKILL_CONTEXT_TOKENS = 9_000
/** A suggestion needs at least this much typed to be worth computing. */
export const MIN_SUGGEST_CHARS = 8

export interface SkillMeta {
  id: string
  name: string
  description: string
  tokens: number
}

export interface SkillIndex {
  source: { repo: string; commit: string; license: string; author: string }
  skills: SkillMeta[]
}

const STORAGE_KEY = 'playground.skills'

// ── Loading ────────────────────────────────────────────────────────────────

const base = () => `${import.meta.env.BASE_URL}skills/`

let indexPromise: Promise<SkillIndex> | null = null
const bodyPromises = new Map<string, Promise<string>>()

async function fetchChecked(url: string): Promise<Response> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res
}

/** The list of skills (names, descriptions, token estimates). Cached; a failure is not. */
export function loadSkillIndex(): Promise<SkillIndex> {
  indexPromise ??= fetchChecked(`${base()}index.json`).then(r => r.json() as Promise<SkillIndex>)
  indexPromise.catch(() => { indexPromise = null })
  return indexPromise
}

/** The Markdown of one skill. Cached per id; a failure is not. */
export function loadSkillBody(id: string): Promise<string> {
  let promise = bodyPromises.get(id)
  if (!promise) {
    promise = fetchChecked(`${base()}${encodeURIComponent(id)}.md`).then(r => r.text())
    bodyPromises.set(id, promise)
    promise.catch(() => bodyPromises.delete(id))
  }
  return promise
}

// ── Which skills are on ────────────────────────────────────────────────────

/** Turn a skill on or off; turning one on past the limit is refused (returns null). */
export function toggleSkill(active: string[], id: string, max = MAX_ACTIVE_SKILLS): string[] | null {
  if (active.includes(id)) return active.filter(a => a !== id)
  return active.length >= max ? null : [...active, id]
}

/** Keep only ids that exist, in order, without duplicates, within the limit. */
export function sanitizeActive(ids: unknown, known: Set<string>, max = MAX_ACTIVE_SKILLS): string[] {
  if (!Array.isArray(ids)) return []
  const out: string[] = []
  for (const id of ids) {
    if (typeof id === 'string' && known.has(id) && !out.includes(id)) out.push(id)
    if (out.length >= max) break
  }
  return out
}

export function readActiveSkills(): unknown {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

export function writeActiveSkills(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch { /* storage unavailable: the choice just does not persist */ }
}

export function activeTokens(active: string[], index: SkillIndex | null): number {
  if (!index) return 0
  const byId = new Map(index.skills.map(s => [s.id, s.tokens]))
  return active.reduce((sum, id) => sum + (byId.get(id) ?? 0), 0)
}

/** "3.4k" for 3 400 tokens, "820" below a thousand. */
export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(tokens)
}

// ── What the model is told ─────────────────────────────────────────────────

const PREAMBLE =
  'The user switched on the working guidelines below for this conversation ("Agent Skills" by Addy Osmani, MIT). ' +
  'Follow them. You are in a chat: you cannot run commands, read the user\'s files or call tools, so wherever a ' +
  'guideline says to run, open or edit something, tell the user what to do or ask them for the output instead. ' +
  'Say which skill you are applying when it shapes your answer.'

/** The system message that carries the active skills. */
export function skillsSystemMessage(skills: Array<{ name: string; body: string }>): string {
  return [PREAMBLE, ...skills.map(s => `## Skill: ${s.name}\n\n${s.body.trim()}`)].join('\n\n')
}

// ── Suggestions ────────────────────────────────────────────────────────────

export function normalizeForMatch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Keywords of `triggers` found in `text` (already normalised): by word start, or whole word with a leading "=". */
export function matchedTriggers(text: string, triggers: string[]): string[] {
  return triggers.filter(trigger => {
    const whole = trigger.startsWith('=')
    const word = escapeRegExp(whole ? trigger.slice(1) : trigger)
    return new RegExp(`(^|[^a-z0-9])${word}${whole ? '($|[^a-z0-9])' : ''}`).test(text)
  })
}

export interface SkillSuggestion {
  id: string
  matched: string[]
}

/** Up to `limit` skills whose keywords appear in what the person is typing, best first. */
export function suggestSkills(
  text: string,
  known: Set<string>,
  opts: { exclude?: string[]; limit?: number } = {},
): SkillSuggestion[] {
  const normalized = normalizeForMatch(text)
  if (normalized.trim().length < MIN_SUGGEST_CHARS) return []
  const exclude = new Set(opts.exclude ?? [])
  return Object.entries(SKILL_TRIGGERS)
    .filter(([id]) => known.has(id) && !exclude.has(id))
    .map(([id, triggers]) => ({ id, matched: matchedTriggers(normalized, triggers) }))
    .filter(s => s.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length)
    .slice(0, opts.limit ?? 2)
}
