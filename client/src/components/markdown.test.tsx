// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Markdown } from './markdown'
import { I18nProvider } from '@/i18n'

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

async function render(markdown: string) {
  await act(async () => { root.render(<I18nProvider><Markdown>{markdown}</Markdown></I18nProvider>) })
  // KaTeX is fetched on first use: give the dynamic imports time to settle.
  await act(async () => { await new Promise(r => setTimeout(r, 300)) })
}

it('renders inline and display formulas with KaTeX in every delimiter dialect', async () => {
  await render('Inline $x^2$ and \\(y_1\\).\n\n\\[\nE = mc^2\n\\]\n\n$$\n\\int_0^1 t\\,dt\n$$')
  expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(4)
  expect(container.querySelectorAll('.katex-display').length).toBe(2)
  expect(container.textContent).not.toContain('$')
  expect(container.textContent).not.toContain('\\(')
})

it('leaves prices as plain text and never loads math for them', async () => {
  await render('It costs $5 and $10 today.')
  expect(container.querySelector('.katex')).toBeNull()
  expect(container.textContent).toContain('It costs $5 and $10 today.')
})

it('does not turn dollars inside code into math', async () => {
  await render('Use `$x$` here:\n\n```js\nconst a = "$y$"\n```')
  expect(container.querySelector('.katex')).toBeNull()
  expect(container.textContent).toContain('$x$')
  expect(container.textContent).toContain('"$y$"')
})

it('shows malformed math as an error instead of failing the whole reply', async () => {
  await render('Broken $\\frac{1}{$ then fine text after.\n\n$$\\notacommand{x}$$')
  expect(container.textContent).toContain('then fine text after.')
})
