import { useEffect, useRef, useState } from 'react'
import { Captions, CaptionsOff, Mic, MicOff, PhoneOff } from 'lucide-react'
import { useI18n } from '@/i18n'
import type { VoiceState } from '@/lib/voice'
import { cn } from '@/lib/utils'

// Full-screen voice call, in the style of ChatGPT's: a living orb that swells
// with your voice and pulses while the assistant thinks or talks, a running
// transcript of the call, mute and hang-up. The orb is also a button: tap it
// while the assistant is talking to cut in. All audio plumbing stays in
// useVoiceMode; this only renders its state.

export interface VoiceCallTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface VoiceCallOverlayProps {
  state: VoiceState
  /** Microphone RMS, 0..1. */
  level: number
  muted: boolean
  /** The call so far, oldest first; the last assistant turn may still be streaming. */
  turns: VoiceCallTurn[]
  error: string | null
  voiceName: string
  onVoiceNameChange: (value: string) => void
  onToggleMute: () => void
  onInterrupt: () => void
  onRecover: () => void
  onEnd: () => void
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

const TRANSCRIPT_KEY = 'voiceCall.transcript'

const ORB_COLOR: Record<VoiceState, string> = {
  idle: 'from-slate-400 to-slate-600',
  listening: 'from-sky-400 to-blue-600',
  transcribing: 'from-violet-400 to-indigo-600',
  thinking: 'from-violet-400 to-fuchsia-600',
  speaking: 'from-emerald-400 to-teal-600',
  error: 'from-red-400 to-rose-600',
}

export function VoiceCallOverlay({
  state, level, muted, turns, error, voiceName,
  onVoiceNameChange, onToggleMute, onInterrupt, onRecover, onEnd,
}: VoiceCallOverlayProps) {
  const { t } = useI18n()
  const [seconds, setSeconds] = useState(0)
  const [showTranscript, setShowTranscript] = useState(() => {
    try { return localStorage.getItem(TRANSCRIPT_KEY) !== 'off' } catch { return true }
  })
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = window.setInterval(() => setSeconds(s => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onEnd() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onEnd])

  // Follow the newest words, unless the user has scrolled up to reread.
  const lastContent = turns[turns.length - 1]?.content ?? ''
  useEffect(() => {
    const el = transcriptRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [turns.length, lastContent, showTranscript])

  const toggleTranscript = () => {
    const next = !showTranscript
    setShowTranscript(next)
    try { localStorage.setItem(TRANSCRIPT_KEY, next ? 'on' : 'off') } catch { /* private mode */ }
  }

  const talking = state === 'speaking'
  const busy = state === 'thinking' || state === 'transcribing'
  // The orb follows your voice while you speak; otherwise it breathes.
  const scale = state === 'listening' && !muted ? 1 + Math.min(level * 5, 0.45) : 1
  const canInterrupt = talking || state === 'thinking'
  const label = muted && state === 'listening' ? t('voiceCall.muted') : t(`voiceChat.state.${state}`)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('voiceCall.title')}
      className="fixed inset-0 z-50 flex flex-col items-center bg-background/95 px-4 py-6 backdrop-blur-xl sm:px-6 sm:py-8"
    >
      <div className="text-center text-sm text-muted-foreground">
        <div className="font-medium text-foreground">{t('voiceCall.title')}</div>
        <div className="tabular-nums">{formatDuration(seconds)}</div>
      </div>

      <div className="flex min-h-0 w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 py-4">
        <button
          type="button"
          onClick={onInterrupt}
          disabled={!canInterrupt}
          aria-label={canInterrupt ? t('voiceCall.interrupt') : label}
          title={canInterrupt ? t('voiceCall.interrupt') : undefined}
          className={cn(
            'relative flex shrink-0 items-center justify-center rounded-full outline-none transition-[width,height] duration-300 focus-visible:ring-4 focus-visible:ring-ring/50 disabled:cursor-default',
            // The transcript needs the room; the orb shrinks to make it.
            showTranscript ? 'size-32' : 'size-56',
          )}
        >
          <span
            className={cn(
              'absolute inset-0 rounded-full bg-gradient-to-br opacity-30 blur-2xl transition-colors duration-500',
              ORB_COLOR[state],
              (talking || busy) && 'animate-pulse',
            )}
          />
          <span
            className={cn(
              'relative rounded-full bg-gradient-to-br shadow-2xl transition-[transform,background-color] duration-150 ease-out motion-reduce:transition-none',
              showTranscript ? 'size-24' : 'size-40',
              ORB_COLOR[state],
              talking && 'animate-pulse',
              busy && 'animate-pulse [animation-duration:1.4s]',
              muted && 'opacity-50',
            )}
            style={{ transform: `scale(${scale})` }}
          />
        </button>

        <div className="text-center text-lg font-medium" aria-live="polite">{label}</div>

        {showTranscript && (
          <div
            ref={transcriptRef}
            aria-label={t('voiceCall.transcript')}
            className="min-h-0 w-full flex-1 space-y-3 overflow-y-auto rounded-xl border bg-muted/30 p-4 text-sm leading-relaxed"
          >
            {turns.length === 0 ? (
              <p className="text-center text-muted-foreground">{t('voiceCall.transcriptEmpty')}</p>
            ) : turns.map((turn, i) => (
              <div key={i} className={cn('flex', turn.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2',
                    turn.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-background',
                  )}
                >
                  <span className="sr-only">{turn.role === 'user' ? t('voiceCall.you') : t('voiceCall.assistant')}: </span>
                  {turn.content || '…'}
                </div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <p className="text-center text-sm text-destructive">
            {error}{' '}
            <button type="button" className="underline" onClick={onRecover}>{t('voiceChat.continue')}</button>
          </p>
        )}
      </div>

      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-6">
          <button
            type="button"
            onClick={toggleTranscript}
            aria-pressed={showTranscript}
            aria-label={showTranscript ? t('voiceCall.hideTranscript') : t('voiceCall.showTranscript')}
            title={showTranscript ? t('voiceCall.hideTranscript') : t('voiceCall.showTranscript')}
            className="flex size-14 items-center justify-center rounded-full border bg-muted/60 transition-colors hover:bg-muted"
          >
            {showTranscript ? <CaptionsOff className="size-6" /> : <Captions className="size-6" />}
          </button>
          <button
            type="button"
            onClick={onToggleMute}
            aria-pressed={muted}
            aria-label={muted ? t('voiceCall.unmute') : t('voiceCall.mute')}
            title={muted ? t('voiceCall.unmute') : t('voiceCall.mute')}
            className={cn(
              'flex size-14 items-center justify-center rounded-full border transition-colors',
              muted ? 'bg-foreground text-background' : 'bg-muted/60 hover:bg-muted',
            )}
          >
            {muted ? <MicOff className="size-6" /> : <Mic className="size-6" />}
          </button>
          <button
            type="button"
            onClick={onEnd}
            aria-label={t('voiceCall.end')}
            title={t('voiceCall.end')}
            className="flex size-14 items-center justify-center rounded-full bg-red-600 text-white transition-colors hover:bg-red-700"
          >
            <PhoneOff className="size-6" />
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('voiceChat.voice')}
          <input
            className="w-24 rounded border bg-background px-2 py-1 text-foreground"
            value={voiceName}
            onChange={e => onVoiceNameChange(e.target.value)}
            aria-label={t('voiceChat.voice')}
          />
        </label>
      </div>
    </div>
  )
}
