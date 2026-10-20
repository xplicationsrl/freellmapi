// Read a reply aloud with the browser's own speech synthesis. Nothing leaves
// the device and no key is involved; the voices are whatever the OS ships.
//
// A reply is Markdown, so it is reduced to what a person would actually say:
// code blocks and formulas are skipped (read out symbol by symbol they are
// noise), links keep their text, and formatting marks vanish. The result is
// cut into sentence-sized pieces because Chromium silently stops a single long
// utterance after roughly fifteen seconds.

import { normalizeMath } from '@/lib/math-normalize'

export function speechSupported(): boolean {
  return typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof SpeechSynthesisUtterance !== 'undefined'
}

/** The speakable plain text of a Markdown reply. */
export function speakableText(markdown: string): string {
  // Same dialect handling as rendering: `$x$` and `\(x\)` become `$$x$$` first,
  // so every formula is skipped below (a price like "$5 and $10" stays text).
  return normalizeMath(markdown)
    // Fenced code (also one still open at the end) and display/inline math.
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' ')
    .replace(/\\\([\s\S]*?\\\)/g, ' ')
    // Images vanish; a link keeps its label; inline code keeps its content.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`\n]*)`/g, '$1')
    // Raw HTML tags, headings, quotes and list markers, table rules.
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, ' ')
    .replace(/\|/g, ', ')
    // Emphasis marks (keep the words).
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~\n]+?)(?<=\S)\1/g, '$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/** Sentence-sized pieces no longer than `max` characters, in order. */
export function chunkForSpeech(text: string, max = 200): string[] {
  const chunks: string[] = []
  for (const paragraph of text.split(/\n+/)) {
    const sentences = paragraph.match(/[^.!?…]+[.!?…]*["')\]]*\s*/g) ?? [paragraph]
    let current = ''
    for (const raw of sentences) {
      const sentence = raw.trim()
      if (!sentence) continue
      if (current && current.length + 1 + sentence.length > max) {
        chunks.push(current)
        current = ''
      }
      if (sentence.length > max) {
        // One enormous sentence: break it on word boundaries.
        for (const word of sentence.split(' ')) {
          if (current && current.length + 1 + word.length > max) { chunks.push(current); current = '' }
          current = current ? `${current} ${word}` : word
        }
      } else {
        current = current ? `${current} ${sentence}` : sentence
      }
    }
    if (current) chunks.push(current)
  }
  return chunks
}

export interface Speaker {
  /** Start reading `text` in `lang`. `onEnd` fires once when it finishes or fails; a stop() or a newer speak() does not fire it. */
  speak(text: string, lang: string, onEnd: () => void): void
  stop(): void
}

export function createSpeaker(synth: SpeechSynthesis = window.speechSynthesis): Speaker {
  // Each speak() takes a ticket; callbacks from a run that was cancelled (by
  // stop() or by a newer speak()) carry an old ticket and are ignored.
  let ticket = 0
  return {
    speak(text, lang, onEnd) {
      const mine = ++ticket
      synth.cancel()
      const chunks = chunkForSpeech(speakableText(text))
      if (chunks.length === 0) { onEnd(); return }
      chunks.forEach((chunk, i) => {
        const utterance = new SpeechSynthesisUtterance(chunk)
        utterance.lang = lang
        utterance.onend = () => { if (mine === ticket && i === chunks.length - 1) onEnd() }
        // An error on any piece ends the whole reading.
        utterance.onerror = () => {
          if (mine !== ticket) return
          ticket++
          synth.cancel()
          onEnd()
        }
        synth.speak(utterance)
      })
    },
    stop() {
      ticket++
      synth.cancel()
    },
  }
}
