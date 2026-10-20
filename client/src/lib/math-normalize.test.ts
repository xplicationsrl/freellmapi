import { describe, it, expect } from 'vitest'
import { hasMath, normalizeMath } from '@/lib/math-normalize'

describe('normalizeMath', () => {
  it('leaves text without math, and prices, alone', () => {
    expect(normalizeMath('plain text')).toBe('plain text')
    expect(normalizeMath('it costs $5 and $10 today')).toBe('it costs $5 and $10 today')
    expect(normalizeMath('US$5, about €4')).toBe('US$5, about €4')
    expect(normalizeMath('pay \\$5 now')).toBe('pay \\$5 now')
    expect(normalizeMath('a $ not math $ b')).toBe('a $ not math $ b')
  })

  it('turns single-dollar pairs into inline math', () => {
    expect(normalizeMath('Let $x^2$ and $y_1$ be real.')).toBe('Let $$x^2$$ and $$y_1$$ be real.')
    expect(normalizeMath('area is $\\pi r^2$.')).toBe('area is $$\\pi r^2$$.')
  })

  it('finds the formula even when a price comes first', () => {
    expect(normalizeMath('about $5, and $x$ is free')).toBe('about $5, and $$x$$ is free')
  })

  it('converts \\( \\) to inline and \\[ \\] to a display block', () => {
    expect(normalizeMath('so \\( a+b \\) holds')).toBe('so $$a+b$$ holds')
    expect(normalizeMath('Then:\n\\[\nE = mc^2\n\\]\nDone')).toBe('Then:\n\n\n$$\nE = mc^2\n$$\n\n\nDone')
  })

  it('keeps existing $$ math as it is', () => {
    expect(normalizeMath('inline $$a$$ here')).toBe('inline $$a$$ here')
    expect(normalizeMath('$$\nx\n$$')).toBe('$$\nx\n$$')
  })

  it('never touches code: inline spans, fenced blocks, or a fence still streaming', () => {
    expect(normalizeMath('use `$x$` and `\\(y\\)`')).toBe('use `$x$` and `\\(y\\)`')
    const fenced = 'text\n```js\nconst a = "$x$"; // \\(y\\)\n```\nafter $z$'
    expect(normalizeMath(fenced)).toBe('text\n```js\nconst a = "$x$"; // \\(y\\)\n```\nafter $$z$$')
    expect(normalizeMath('go\n```py\nprice = "$x$"')).toBe('go\n```py\nprice = "$x$"')
    expect(normalizeMath('go\n~~~\n$x$\n~~~')).toBe('go\n~~~\n$x$\n~~~')
  })

  it('does not join a pair across lines', () => {
    expect(normalizeMath('first $x\nsecond y$')).toBe('first $x\nsecond y$')
  })
})

describe('hasMath', () => {
  it('is true only once a $$ pair exists in normalised text', () => {
    expect(hasMath(normalizeMath('no math'))).toBe(false)
    expect(hasMath(normalizeMath('costs $5 and $10'))).toBe(false)
    expect(hasMath(normalizeMath('so $x$'))).toBe(true)
    expect(hasMath(normalizeMath('so \\(x\\)'))).toBe(true)
  })
})
