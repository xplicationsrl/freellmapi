import { useEffect, useState } from 'react'
import { Mic, MicOff, PhoneOff } from 'lucide-react'
import { useI18n } from '@/i18n'
import type { VoiceState } from '@/lib/voice'
import { cn } from '@/lib/utils'

// Full-screen voice call, in the style of ChatGPT's: a living orb that swells
// with your voice and pulses while the assistant thinks or talks, live
// captions, mute and hang-up. The orb is also a button: tap it while the
// assistant is talking to cut in. All audio plumbing stays in useVoiceMode;
// this only renders its state.

export interface VoiceCallOverlayProps {
  state: VoiceState
  /** Microphone RMS, 0..1. */
  level: number
  muted: boolean
  /** What the user just said. */
  transcript: string
  /** The assistant's reply so far. */
  reply: string
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

const ORB_COLOR: Record<VoiceState, string> = {
  idle: 'from-slate-400 to-slate-600',
  listening: 'from-sky-400 to-blue-600',
  transcribing: 'from-violet-400 to-indigo-600',
  thinking: 'from-violet-400 to-fuchsia-600',
  speaking: 'from-emerald-400 to-teal-600',
  error: 'from-red-400 to-rose-600',
}

export function VoiceCallOverlay({
  state, level, muted, transcript, reply, error, voiceName,
  onVoiceNameChange, onToggleMute, onInterrupt, onRecover, onEnd,
}: VoiceCallOverlayProps) {
  const { t } = useI18n()
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setSeconds(s => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onEnd() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onEnd])

  const talking = state === 'speaking'
  const busy = state === 'thinking' || state === 'transcribing'
  // The orb follows your voice while you speak; otherwise it breathes.
  const scale = state === 'listening' && !muted ? 1 + Math.min(level * 5, 0.45) : 1
  const canInterrupt = talking || state === 'thinking'
  const caption = state === 'listening' || state === 'transcribing' ? transcript : reply || transcript
  const label = muted && state === 'listening' ? t('voiceCall.muted') : t(`voiceChat.state.${state}`)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('voiceCall.title')}
      className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-background/95 px-6 py-8 backdrop-blur-xl"
    >
      <div className="text-center text-sm text-muted-foreground">
        <div className="font-medium text-foreground">{t('voiceCall.title')}</div>
        <div className="tabular-nums">{formatDuration(seconds)}</div>
      </div>

      <div className="flex w-full max-w-xl flex-col items-center gap-8">
        <button
          type="button"
          onClick={onInterrupt}
          disabled={!canInterrupt}
          aria-label={canInterrupt ? t('voiceCall.interrupt') : label}
          title={canInterrupt ? t('voiceCall.interrupt') : undefined}
          className="relative flex size-56 items-center justify-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-ring/50 disabled:cursor-default"
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
              'relative size-40 rounded-full bg-gradient-to-br shadow-2xl transition-[transform,background-color] duration-150 ease-out motion-reduce:transition-none',
              ORB_COLOR[state],
              talking && 'animate-pulse',
              busy && 'animate-pulse [animation-duration:1.4s]',
              muted && 'opacity-50',
            )}
            style={{ transform: `scale(${scale})` }}
          />
        </button>

        <div className="text-center">
          <div className="text-lg font-medium">{label}</div>
          <p
            className="mt-3 min-h-[4.5rem] max-w-md text-balance text-sm leading-relaxed text-muted-foreground"
            aria-live="polite"
          >
            {caption.length > 280 ? `…${caption.slice(-280)}` : caption}
          </p>
          {error && (
            <p className="mt-2 text-sm text-destructive">
              {error}{' '}
              <button type="button" className="underline" onClick={onRecover}>{t('voiceChat.continue')}</button>
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-6">
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
