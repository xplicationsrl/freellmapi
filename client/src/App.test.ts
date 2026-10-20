import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Keep navigation within the viewport while long pages scroll independently.
const here = path.dirname(fileURLToPath(import.meta.url))
const app = readFileSync(path.join(here, 'App.tsx'), 'utf8')
const playground = readFileSync(path.join(here, 'pages/PlaygroundPage.tsx'), 'utf8')

describe('app shell heights', () => {
  it('pins every route to the viewport so navigation stays visible', () => {
    expect(app).toContain('flex flex-col h-dvh overflow-hidden')
    expect(app).not.toContain('min-h-screen')
  })

  it('lets padded pages scroll independently of the sidebar', () => {
    expect(app).toContain("${fullBleed ? '' : 'overflow-y-auto'}")
    expect(app).toContain('flex min-h-0 min-w-0 flex-1 flex-col')
  })

  it('passes a definite height down the flex chain to the page', () => {
    // Dropping min-h-0/flex-1 anywhere between the shell and the page lets
    // the content size its ancestors again, which is the original bug by
    // another route.
    expect(app).toContain("'flex min-h-0 flex-1 flex-col'")
    expect(playground).toContain('flex min-h-0 flex-1 overflow-hidden')
  })

  it('keeps /playground in the full-bleed set', () => {
    expect(app).toMatch(/FULL_BLEED_ROUTES = new Set\(\[[^\]]*'\/playground'[^\]]*\]\)/)
  })
})

describe('sidebar alignment', () => {
  it('keeps brand spacing consistent across navigation', () => {
    const nav = readFileSync(path.join(here, 'components/app-nav.tsx'), 'utf8')
    const sidebar = readFileSync(path.join(here, 'components/playground/conversation-sidebar.tsx'), 'utf8')
    const spacing = 'flex shrink-0 items-center gap-1 px-3 pt-3 pb-1'
    expect(nav).toContain(spacing)
    expect(sidebar).toContain(spacing)
  })
})
