// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SkillsDialog } from './skills-dialog'
import { I18nProvider } from '@/i18n'
import type { SkillIndex } from '@/lib/skills'

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = '' })

const index: SkillIndex = {
  source: { repo: 'https://github.com/addyosmani/agent-skills', commit: 'c', license: 'MIT', author: 'Addy Osmani' },
  skills: [
    { id: 'interview-me', name: 'interview-me', description: 'Asks one question at a time', tokens: 3770 },
    { id: 'security-and-hardening', name: 'security-and-hardening', description: 'Threat modelling and secure defaults', tokens: 4389 },
    { id: 'code-review-and-quality', name: 'code-review-and-quality', description: 'Five-axis review before merge', tokens: 5244 },
  ],
}

function render(over: Partial<Parameters<typeof SkillsDialog>[0]> = {}) {
  const props = { open: true, onOpenChange: () => {}, index, failed: false, active: [] as string[], onToggle: () => {}, onClear: () => {}, ...over }
  act(() => root.render(<I18nProvider><SkillsDialog {...props} /></I18nProvider>))
}
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]

it('lists every skill with its cost and the attribution', () => {
  render()
  expect(options().map(o => o.textContent)).toEqual([
    expect.stringContaining('interview-me'), expect.stringContaining('security-and-hardening'), expect.stringContaining('code-review-and-quality'),
  ])
  expect(options()[0].textContent).toContain('~3.8k')
  expect(document.body.textContent).toContain('Addy Osmani')
  expect(document.querySelector('a[href="https://github.com/addyosmani/agent-skills"]')).not.toBeNull()
})

it('reports a toggle for the clicked skill and marks the active ones', () => {
  const onToggle = vi.fn()
  render({ onToggle, active: ['security-and-hardening'] })
  expect(options().map(o => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
  act(() => { options()[0].click() })
  expect(onToggle).toHaveBeenCalledWith('interview-me')
})

it('filters by name and description, and says when nothing matches', () => {
  render()
  const input = document.querySelector<HTMLInputElement>('input')!
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  type('threat')
  expect(options()).toHaveLength(1)
  type('zzzzz')
  expect(options()).toHaveLength(0)
  expect(document.body.textContent).toContain('No skill matches.')
})

it('summarises what is on, offers to clear it, and warns when the context is large', () => {
  const onClear = vi.fn()
  render({ active: ['interview-me', 'security-and-hardening', 'code-review-and-quality'], onClear })
  expect(document.body.textContent).toContain('3 on · about 13.4k tokens')
  expect(document.body.textContent).toContain('This is a lot of context')
  act(() => { [...document.querySelectorAll('button')].find(b => b.textContent === 'Turn all off')!.click() })
  expect(onClear).toHaveBeenCalled()
})

it('shows no warning for a single skill, and an error when the library could not load', () => {
  render({ active: ['interview-me'] })
  expect(document.body.textContent).not.toContain('This is a lot of context')
  render({ index: null, failed: true })
  expect(document.body.textContent).toContain('The skills could not be loaded.')
})
