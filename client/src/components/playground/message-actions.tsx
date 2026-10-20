import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Small icon button under a message (Edit on yours, Regenerate on the last
// reply). Quiet until the row is hovered or focused; on touch screens, where
// there is no hover, it is always visible.
export function MessageActionButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/row:opacity-70 [@media(hover:none)]:opacity-70"
    >
      <Icon className="size-3.5" />
    </button>
  )
}

// Inline editor that replaces a sent message while it is being edited.
// Ctrl/Cmd+Enter sends, Escape cancels; a blank text cannot be sent.
export function MessageEditor({ initial, onSubmit, onCancel, labels }: {
  initial: string
  onSubmit: (text: string) => void
  onCancel: () => void
  labels: { send: string; cancel: string }
}) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // Grow with the text instead of scrolling inside a small box.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [text])

  const canSend = text.trim().length > 0
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend) {
      e.preventDefault()
      onSubmit(text)
    }
  }

  return (
    <div className="flex w-full min-w-[min(28rem,100%)] flex-col gap-2 rounded-2xl border bg-muted/40 p-3">
      <textarea
        ref={ref}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        className="w-full resize-none bg-transparent text-sm leading-relaxed outline-none"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{labels.cancel}</Button>
        <Button type="button" size="sm" disabled={!canSend} onClick={() => onSubmit(text)}>{labels.send}</Button>
      </div>
    </div>
  )
}
