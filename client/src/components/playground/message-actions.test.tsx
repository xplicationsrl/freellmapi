// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Pencil } from 'lucide-react'
import { MessageActionButton, MessageEditor } from './message-actions'

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const labels = { send: 'Save and send', cancel: 'Cancel' }
const textarea = () => container.querySelector('textarea')!
const button = (name: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === name)!

function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function key(init: KeyboardEventInit) {
  act(() => { textarea().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })) })
}

it('starts with the original text, focused, and sends the edited text', () => {
  const onSubmit = vi.fn()
  act(() => root.render(<MessageEditor initial="hello" onSubmit={onSubmit} onCancel={() => {}} labels={labels} />))
  expect(textarea().value).toBe('hello')
  expect(document.activeElement).toBe(textarea())
  type('hello again')
  act(() => { button('Save and send').click() })
  expect(onSubmit).toHaveBeenCalledWith('hello again')
})

it('cannot send blank text, with the button or the shortcut', () => {
  const onSubmit = vi.fn()
  act(() => root.render(<MessageEditor initial="hello" onSubmit={onSubmit} onCancel={() => {}} labels={labels} />))
  type('   ')
  expect(button('Save and send').disabled).toBe(true)
  key({ key: 'Enter', ctrlKey: true })
  expect(onSubmit).not.toHaveBeenCalled()
})

it('sends on Ctrl/Cmd+Enter, keeps plain Enter for new lines, and cancels on Escape', () => {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  act(() => root.render(<MessageEditor initial="hello" onSubmit={onSubmit} onCancel={onCancel} labels={labels} />))
  key({ key: 'Enter' })
  expect(onSubmit).not.toHaveBeenCalled()
  key({ key: 'Enter', metaKey: true })
  expect(onSubmit).toHaveBeenCalledWith('hello')
  key({ key: 'Escape' })
  expect(onCancel).toHaveBeenCalledTimes(1)
})

it('renders an action button that is named for screen readers and clickable', () => {
  const onClick = vi.fn()
  act(() => root.render(<MessageActionButton icon={Pencil} label="Edit message" onClick={onClick} />))
  const b = container.querySelector<HTMLButtonElement>('button[aria-label="Edit message"]')!
  act(() => { b.click() })
  expect(onClick).toHaveBeenCalledTimes(1)
})

it('shows a toggled-on action at full strength and exposes it as pressed', () => {
  act(() => root.render(<MessageActionButton icon={Pencil} label="Good response" onClick={() => {}} active />))
  const on = container.querySelector<HTMLButtonElement>('button')!
  expect(on.getAttribute('aria-pressed')).toBe('true')
  expect(on.className).toContain('opacity-100')

  act(() => root.render(<MessageActionButton icon={Pencil} label="Good response" onClick={() => {}} active={false} />))
  const off = container.querySelector<HTMLButtonElement>('button')!
  expect(off.getAttribute('aria-pressed')).toBe('false')
  expect(off.className).toContain('opacity-0')
})

it('is not a toggle (no aria-pressed) when active is not given', () => {
  act(() => root.render(<MessageActionButton icon={Pencil} label="Edit message" onClick={() => {}} />))
  expect(container.querySelector('button')!.hasAttribute('aria-pressed')).toBe(false)
})
