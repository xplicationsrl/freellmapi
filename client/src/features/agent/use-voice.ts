import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE } from '@/lib/api'
import { pickRecordingMimeType, recordingFilename } from '@/lib/transcription'
import {
  createVad,
  nextVoiceState,
  speakable,
  SpeechQueue,
  takeSentences,
  type Vad,
  type VoiceAction,
  type VoiceState,
  type VoiceTurnMetrics,
} from '@/lib/voice'

// Continuous voice conversation: the microphone is watched for speech, each
// utterance is transcribed, answered by the same conversation run as typed
// text, and the reply is spoken sentence by sentence. Speaking over the
// assistant interrupts it: queued audio is discarded, the run is cancelled and
// only the part the user actually heard is reported back as delivered.

const LISTEN_THRESHOLD = 0.04
// While the assistant talks, its own audio leaks into the mic; a higher bar
// keeps that from being mistaken for the user.
const SPEAKING_THRESHOLD = 0.12

export interface VoiceSendHooks {
  signal: AbortSignal
  /** Called for each streamed text delta of the reply. */
  onDelta: (text: string) => void
  /** Called once the reply is fully generated. */
  onGenerated: () => void
}

export interface UseVoiceOptions {
  apiKey: string | undefined
  transcriptionModel: string
  speechModel: string
  voice: string
  /** Run one turn with the transcript; resolves when the run ends. */
  send: (text: string, hooks: VoiceSendHooks) => Promise<void>
  /** Stop the in-flight run (barge-in). */
  cancelRun: () => void
  /** The user interrupted: `delivered` is what was actually spoken. */
  onInterrupted: (delivered: string) => void
}

export function useVoiceMode(options: UseVoiceOptions) {
  const optsRef = useRef(options)
  useEffect(() => { optsRef.current = options })

  const [state, setState] = useState<VoiceState>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState('')
  const [metrics, setMetrics] = useState<VoiceTurnMetrics>({})
  const [muted, setMutedState] = useState(false)

  const stateRef = useRef<VoiceState>('idle')
  const streamRef = useRef<MediaStream | null>(null)
  const vadRef = useRef<Vad | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const queueRef = useRef(new SpeechQueue())
  const turnRef = useRef(0)
  const turnAbortRef = useRef<AbortController | null>(null)
  const timingRef = useRef<{ speechEnd: number; transcribed: number; sent: number; metrics: VoiceTurnMetrics }>(
    { speechEnd: 0, transcribed: 0, sent: 0, metrics: {} },
  )

  const dispatch = useCallback((action: VoiceAction) => {
    const next = nextVoiceState(stateRef.current, action)
    stateRef.current = next
    setState(next)
  }, [])

  const fail = useCallback((message: string) => {
    setError(message)
    dispatch('fail')
  }, [dispatch])

  const fetchSpeech = useCallback(async (text: string, signal: AbortSignal): Promise<Blob> => {
    const { apiKey, speechModel, voice } = optsRef.current
    const res = await fetch(`${API_BASE}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: speechModel === 'auto' ? undefined : speechModel, input: text, voice, response_format: 'mp3' }),
      signal,
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
      throw new Error(body?.error?.message || `speech HTTP ${res.status}`)
    }
    return res.blob()
  }, [])

  const transcribe = useCallback(async (blob: Blob): Promise<string> => {
    const { apiKey, transcriptionModel } = optsRef.current
    const form = new FormData()
    form.append('file', blob, recordingFilename(blob.type))
    form.append('model', transcriptionModel)
    form.append('response_format', 'json')
    const res = await fetch(`${API_BASE}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
      throw new Error(body?.error?.message || `transcription HTTP ${res.status}`)
    }
    return ((await res.json()) as { text?: string }).text?.trim() ?? ''
  }, [])

  const interrupt = useCallback(() => {
    turnRef.current += 1
    const delivered = queueRef.current.delivered()
    queueRef.current.reset()
    turnAbortRef.current?.abort()
    optsRef.current.cancelRun()
    optsRef.current.onInterrupted(delivered)
  }, [])

  const runTurn = useCallback(async (text: string) => {
    const turn = ++turnRef.current
    const abort = new AbortController()
    turnAbortRef.current = abort
    const queue = queueRef.current
    queue.reset()
    const timing = timingRef.current
    timing.sent = performance.now()
    let sawFirstToken = false
    let buffer = ''
    let chain: Promise<void> = Promise.resolve()
    let generated = false

    const speak = (sentence: string) => {
      const clean = speakable(sentence)
      if (!clean) return
      const requestedAt = performance.now()
      const pending = fetchSpeech(clean, abort.signal)
      chain = chain.then(() => pending).then(blob => {
        if (turn !== turnRef.current) return
        if (timing.metrics.speechGenerationMs === undefined) {
          timing.metrics.speechGenerationMs = Math.round(performance.now() - requestedAt)
        }
        queue.enqueue(sentence, blob)
      }).catch(err => {
        if (turn === turnRef.current && !abort.signal.aborted) {
          fail(err instanceof Error ? err.message : 'Speech failed')
        }
      })
    }

    queue.onStart = () => {
      if (turn !== turnRef.current) return
      if (timing.metrics.playbackStartMs === undefined) {
        timing.metrics.playbackStartMs = Math.round(performance.now() - timing.speechEnd)
        setMetrics({ ...timing.metrics })
      }
      dispatch('playback-started')
      vadRef.current?.setThreshold(SPEAKING_THRESHOLD)
    }
    queue.onIdle = () => {
      if (turn !== turnRef.current || !generated) return
      vadRef.current?.setThreshold(LISTEN_THRESHOLD)
      dispatch('reply-finished')
    }

    try {
      dispatch('reply-started')
      await optsRef.current.send(text, {
        signal: abort.signal,
        onDelta: delta => {
          if (turn !== turnRef.current) return
          if (!sawFirstToken) {
            sawFirstToken = true
            timing.metrics.firstTokenMs = Math.round(performance.now() - timing.sent)
          }
          buffer += delta
          const out = takeSentences(buffer)
          buffer = out.rest
          out.sentences.forEach(speak)
        },
        onGenerated: () => { generated = true },
      })
      if (turn !== turnRef.current) return
      generated = true
      takeSentences(buffer, true).sentences.forEach(speak)
      await chain
      if (turn !== turnRef.current) return
      if (!queue.playing) {
        vadRef.current?.setThreshold(LISTEN_THRESHOLD)
        dispatch('reply-finished')
      }
    } catch (err) {
      if (turn === turnRef.current && !abort.signal.aborted) {
        fail(err instanceof Error ? err.message : 'The reply failed')
      }
    }
  }, [dispatch, fail, fetchSpeech])

  /** Cut the assistant off now (tap-to-interrupt) and go back to listening. */
  const bargeIn = useCallback(() => {
    const s = stateRef.current
    if (s !== 'speaking' && s !== 'thinking') return
    interrupt()
    dispatch('barge-in')
    vadRef.current?.setThreshold(LISTEN_THRESHOLD)
  }, [dispatch, interrupt])

  /** Mute silences the microphone track, so the detector hears nothing. */
  const setMuted = useCallback((value: boolean) => {
    setMutedState(value)
    streamRef.current?.getAudioTracks().forEach(track => { track.enabled = !value })
  }, [])

  const handleUtterance = useCallback(async (blob: Blob) => {
    dispatch('speech-end')
    const timing = timingRef.current
    timing.speechEnd = performance.now()
    timing.metrics = {}
    try {
      if (blob.size === 0) throw new Error('nothing was recorded')
      const text = await transcribe(blob)
      timing.metrics.transcribeMs = Math.round(performance.now() - timing.speechEnd)
      setMetrics({ ...timing.metrics })
      if (!text) {
        // Noise, not speech: go back to listening.
        dispatch('transcript')
        dispatch('reply-finished')
        return
      }
      setTranscript(text)
      dispatch('transcript')
      await runTurn(text)
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Transcription failed')
    }
  }, [dispatch, fail, runTurn, transcribe])

  const startRecording = useCallback(() => {
    const stream = streamRef.current
    if (!stream || recorderRef.current) return
    const mimeType = pickRecordingMimeType(t => MediaRecorder.isTypeSupported(t))
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    chunksRef.current = []
    recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' })
      recorderRef.current = null
      if (stateRef.current !== 'idle' && stateRef.current !== 'error') void handleUtterance(blob)
    }
    recorderRef.current = recorder
    recorder.start()
  }, [handleUtterance])

  const start = useCallback(async () => {
    if (streamRef.current) return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream
      vadRef.current = createVad(stream, {
        threshold: LISTEN_THRESHOLD,
        onLevel: setLevel,
        onSpeechStart: () => {
          const s = stateRef.current
          if (s === 'speaking' || s === 'thinking') {
            interrupt()
            dispatch('barge-in')
            vadRef.current?.setThreshold(LISTEN_THRESHOLD)
          }
          if (stateRef.current === 'listening') startRecording()
        },
        onSpeechEnd: () => {
          if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
        },
      })
      dispatch('start')
    } catch (err) {
      streamRef.current?.getTracks().forEach(tr => tr.stop())
      streamRef.current = null
      fail(err instanceof Error && err.name === 'NotAllowedError'
        ? 'Microphone permission was denied'
        : err instanceof Error ? err.message : 'Could not open the microphone')
    }
  }, [dispatch, fail, interrupt, startRecording])

  const stop = useCallback(() => {
    turnRef.current += 1
    turnAbortRef.current?.abort()
    queueRef.current.reset()
    vadRef.current?.stop()
    vadRef.current = null
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    recorderRef.current = null
    // Release the microphone: the indicator in the browser must go off.
    streamRef.current?.getTracks().forEach(tr => tr.stop())
    streamRef.current = null
    stateRef.current = 'idle'
    setState('idle')
    setLevel(0)
    setMutedState(false)
  }, [])

  useEffect(() => stop, [stop])

  /** Leave the error state and resume listening. */
  const recover = useCallback(() => {
    setError(null)
    stateRef.current = streamRef.current ? 'listening' : 'idle'
    setState(stateRef.current)
  }, [])

  return { state, level, error, transcript, metrics, muted, setMuted, bargeIn, start, stop, recover, active: state !== 'idle' }
}
