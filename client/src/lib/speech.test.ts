import { beforeAll, describe, it, expect, vi } from 'vitest'
import { chunkForSpeech, createSpeaker, speakableText } from '@/lib/speech'

describe('speakableText', () => {
  it('drops code, formulas and images but keeps link text and inline code', () => {
    const md = 'Use `npm test` or see [the docs](https://x.y).\n\n```js\nconst a = 1\n```\n\nThen $$x^2$$ and \\(y\\) hold. ![logo](a.png)'
    expect(speakableText(md)).toBe('Use npm test or see the docs.\nThen and hold.')
  })

  it('removes structure marks and keeps the words', () => {
    const md = '# Title\n\n> quoted **bold** and *italic*\n\n- one\n- two\n1. first'
    expect(speakableText(md)).toBe('Title\nquoted bold and italic\none\ntwo\nfirst')
  })

  it('reads table cells as separated phrases, without the rule line', () => {
    expect(speakableText('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(', a , b ,\n, 1 , 2 ,')
  })

  it('skips single-dollar formulas too, but not prices', () => {
    expect(speakableText('Let $x^2$ be real; it costs $5 and $10.')).toBe('Let be real; it costs $5 and $10.')
  })

  it('skips a code fence that is still open', () => {
    expect(speakableText('before\n```py\nx = 1')).toBe('before')
  })

  it('leaves ordinary prose, diacritics and a lone underscore alone', () => {
    expect(speakableText('Bună ziua, snake_case e ok.')).toBe('Bună ziua, snake_case e ok.')
  })
})

describe('chunkForSpeech', () => {
  it('keeps short text whole and splits on sentences once past the limit', () => {
    expect(chunkForSpeech('One. Two.', 200)).toEqual(['One. Two.'])
    expect(chunkForSpeech('Alpha beta. Gamma delta. Epsilon.', 20)).toEqual(['Alpha beta.', 'Gamma delta.', 'Epsilon.'])
  })

  it('never exceeds the limit, even for one enormous sentence', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkForSpeech(long, 50)
    expect(chunks.length).toBeGreaterThan(5)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50)
    expect(chunks.join(' ')).toBe(long)
  })

  it('splits paragraphs and returns nothing for empty text', () => {
    expect(chunkForSpeech('First.\n\nSecond.')).toEqual(['First.', 'Second.'])
    expect(chunkForSpeech('')).toEqual([])
  })
})

// A minimal SpeechSynthesis: records what was queued and lets the test end or break pieces.
function fakeSynth() {
  const queued: SpeechSynthesisUtterance[] = []
  const synth = {
    cancel: vi.fn(() => { queued.length = 0 }),
    speak: vi.fn((u: SpeechSynthesisUtterance) => { queued.push(u) }),
  }
  return { synth: synth as unknown as SpeechSynthesis, queued, raw: synth }
}

class FakeUtterance { text: string; lang = ''; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(t: string) { this.text = t } }

describe('createSpeaker', () => {
  beforeAll(() => { (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = FakeUtterance })

  it('queues one utterance per chunk in the given language and ends after the last', () => {
    const { synth, queued } = fakeSynth()
    const onEnd = vi.fn()
    createSpeaker(synth).speak('Alpha beta. Gamma delta.', 'ro', onEnd)
    expect(queued.length).toBe(1)
    expect((queued[0] as unknown as FakeUtterance).lang).toBe('ro')
    ;(queued[0] as unknown as FakeUtterance).onend?.()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('does not call onEnd for a reading that stop() cancelled, but does after an error', () => {
    const { synth, queued, raw } = fakeSynth()
    const speaker = createSpeaker(synth)
    const stopped = vi.fn()
    speaker.speak('One two three.', 'en', stopped)
    const first = queued[0] as unknown as FakeUtterance
    speaker.stop()
    first.onend?.(); first.onerror?.()
    expect(stopped).not.toHaveBeenCalled()
    expect(raw.cancel).toHaveBeenCalled()

    const failed = vi.fn()
    speaker.speak('Another one.', 'en', failed)
    ;(queued[0] as unknown as FakeUtterance).onerror?.()
    expect(failed).toHaveBeenCalledTimes(1)
  })

  it('a newer reading replaces the older one without firing the older onEnd', () => {
    const { synth, queued } = fakeSynth()
    const speaker = createSpeaker(synth)
    const a = vi.fn(); const b = vi.fn()
    speaker.speak('First reply.', 'en', a)
    const old = queued[0] as unknown as FakeUtterance
    speaker.speak('Second reply.', 'en', b)
    old.onend?.()
    expect(a).not.toHaveBeenCalled()
    ;(queued[0] as unknown as FakeUtterance).onend?.()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('ends immediately when there is nothing speakable', () => {
    const { synth, queued } = fakeSynth()
    const onEnd = vi.fn()
    createSpeaker(synth).speak('```js\ncode only\n```', 'en', onEnd)
    expect(queued.length).toBe(0)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
})
