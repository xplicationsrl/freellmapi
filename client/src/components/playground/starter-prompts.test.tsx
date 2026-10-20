// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Lightbulb, Mail } from 'lucide-react'
import { StarterPrompts, type StarterPrompt } from './starter-prompts'

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const items: StarterPrompt[] = [
  { id: 'explain', icon: Lightbulb, label: 'Explain something', prompt: 'Explain this in simple terms: ' },
  { id: 'write', icon: Mail, label: 'Write an email', prompt: 'Write a professional email about: ' },
]

it('shows one chip per suggestion', () => {
  act(() => root.render(<StarterPrompts items={items} onPick={() => {}} />))
  expect([...container.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Explain something', 'Write an email'])
})

it('hands the full prompt (not the chip label) to onPick, exactly as written', () => {
  const onPick = vi.fn()
  act(() => root.render(<StarterPrompts items={items} onPick={onPick} />))
  act(() => { container.querySelectorAll('button')[1].click() })
  expect(onPick).toHaveBeenCalledTimes(1)
  expect(onPick).toHaveBeenCalledWith('Write a professional email about: ')
})
