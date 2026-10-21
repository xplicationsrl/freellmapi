// Voice conversation helpers: the pure parts (sentence splitting for chunked
// speech, the turn state machine, latency bookkeeping) and the thin browser
// pieces (voice activity detection, ordered audio playback). The pipeline is
// chained: microphone -> /v1/audio/transcriptions -> conversation run ->
// /v1/audio/speech per sentence -> playback.

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'

export type VoiceAction =
  | 'start' | 'speech-start' | 'speech-end' | 'transcript' | 'reply-started'
  | 'playback-started' | 'reply-finished' | 'barge-in' | 'fail' | 'stop'

/** Pure transition table; unknown pairs keep the current state. */
export function nextVoiceState(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action) {
    case 'start': return 'listening'
    case 'stop': return 'idle'
    case 'fail': return 'error'
    case 'speech-start': return state === 'listening' ? 'listening' : state
    case 'speech-end': return state === 'listening' ? 'transcribing' : state
    case 'transcript': return state === 'transcribing' ? 'thinking' : state
    case 'reply-started': return state === 'thinking' ? 'thinking' : state
    case 'playback-started': return state === 'thinking' || state === 'speaking' ? 'speaking' : state
    case 'barge-in': return state === 'speaking' || state === 'thinking' ? 'listening' : state
    case 'reply-finished': return state === 'speaking' || state === 'thinking' ? 'listening' : state
    default: return state
  }
}

const TERMINATORS = /([.!?。！？]+["')\]]*)(\s+|$)/

/**
 * Cut complete sentences off the front of a streaming buffer. The tail without
 * a terminator stays in `rest` until more text (or `flush`) arrives. Pieces
 * shorter than `minChars` are merged into the next sentence so abbreviations
 * and "1." do not become their own clip.
 */
export function takeSentences(buffer: string, flush = false, minChars = 24): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  let rest = buffer
  let pending = ''
  for (;;) {
    const m = TERMINATORS.exec(rest)
    // A terminator at the very end of a streaming buffer may be mid-number or
    // mid-ellipsis; wait for the next character unless flushing.
    if (!m || (!flush && m.index + m[0].length >= rest.length && !/\s$/.test(m[0]))) break
    const end = m.index + m[0].length
    pending += rest.slice(0, end)
    rest = rest.slice(end)
    if (pending.trim().length >= minChars) {
      sentences.push(pending.trim())
      pending = ''
    }
  }
  rest = pending + rest
  if (flush && rest.trim()) {
    sentences.push(rest.trim())
    rest = ''
  }
  return { sentences, rest }
}

/** Strip Markdown so it is not read aloud. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[kb:\d+#\d+\]/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface VoiceTurnMetrics {
  /** Speech end -> transcript received. */
  transcribeMs?: number
  /** Transcript sent -> first text token. */
  firstTokenMs?: number
  /** First sentence complete -> its audio received. */
  speechGenerationMs?: number
  /** Speech end -> first audible sound. */
  playbackStartMs?: number
}

// ---------- voice activity detection ----------

export interface VadOptions {
  /** RMS (0..1) above which sound counts as speech. */
  threshold?: number
  /** Silence after speech that ends the turn. */
  silenceMs?: number
  /** Ignore blips shorter than this. */
  minSpeechMs?: number
  onSpeechStart: () => void
  onSpeechEnd: () => void
  /** Level callback for the mic indicator. */
  onLevel?: (rms: number) => void
}

export interface Vad {
  stop(): void
  /** Raise the bar while the assistant is talking so its own audio is not heard as the user. */
  setThreshold(value: number): void
}

export function createVad(stream: MediaStream, opts: VadOptions): Vad {
  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)
  const data = new Float32Array(analyser.fftSize)

  let threshold = opts.threshold ?? 0.04
  const silenceMs = opts.silenceMs ?? 900
  const minSpeechMs = opts.minSpeechMs ?? 250
  let speaking = false
  let speechStartedAt = 0
  let lastLoud = 0
  let stopped = false

  const tick = () => {
    if (stopped) return
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length)
    opts.onLevel?.(rms)
    const now = performance.now()
    if (rms >= threshold) {
      lastLoud = now
      if (!speaking) {
        speaking = true
        speechStartedAt = now
        opts.onSpeechStart()
      }
    } else if (speaking && now - lastLoud >= silenceMs) {
      speaking = false
      if (lastLoud - speechStartedAt >= minSpeechMs) opts.onSpeechEnd()
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  return {
    stop() {
      stopped = true
      source.disconnect()
      void ctx.close().catch(() => undefined)
    },
    setThreshold(value: number) { threshold = value },
  }
}

// ---------- ordered playback ----------

/**
 * Plays clips strictly in order. `stop()` discards everything queued and
 * silences the current clip; `delivered()` returns the text of the clips that
 * actually started playing, so an interrupted answer can be stored as what the
 * user really heard.
 */
export class SpeechQueue {
  private queue: { text: string; url: string }[] = []
  private current: HTMLAudioElement | null = null
  private heard: string[] = []
  private generation = 0
  onStart?: () => void
  onIdle?: () => void

  enqueue(text: string, audio: Blob): void {
    this.queue.push({ text, url: URL.createObjectURL(audio) })
    if (!this.current) this.playNext()
  }

  private playNext(): void {
    const item = this.queue.shift()
    if (!item) {
      this.current = null
      this.onIdle?.()
      return
    }
    const gen = this.generation
    const el = new Audio(item.url)
    this.current = el
    const done = () => {
      URL.revokeObjectURL(item.url)
      if (gen !== this.generation) return
      this.current = null
      this.playNext()
    }
    el.onended = done
    el.onerror = done
    el.play().then(() => {
      if (gen !== this.generation) return
      this.heard.push(item.text)
      this.onStart?.()
    }).catch(done)
  }

  get playing(): boolean {
    return this.current !== null || this.queue.length > 0
  }

  stop(): void {
    this.generation += 1
    for (const q of this.queue) URL.revokeObjectURL(q.url)
    this.queue = []
    if (this.current) {
      this.current.pause()
      this.current = null
    }
  }

  delivered(): string {
    return this.heard.join(' ')
  }

  reset(): void {
    this.stop()
    this.heard = []
  }
}
