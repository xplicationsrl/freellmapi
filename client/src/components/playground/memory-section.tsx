import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import type { Memory } from '@/lib/playground-memories'
import { MAX_MEMORY_LEN } from '@/lib/playground-memories'

// Memory block inside the Playground settings rail: toggle, list, add, delete.
// State lives on the page; this only renders and bubbles edits up.

export interface MemorySectionProps {
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  memories: Memory[]
  onAdd: (content: string) => Promise<void>
  onDelete: (id: number) => Promise<void>
  busy?: boolean
}

export function MemorySection({
  enabled,
  onEnabledChange,
  memories,
  onAdd,
  onDelete,
  busy = false,
}: MemorySectionProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const add = async () => {
    const content = draft.trim()
    if (!content || saving) return
    setSaving(true)
    try {
      await onAdd(content)
      setDraft('')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: number) => {
    if (deletingId !== null) return
    setDeletingId(id)
    try {
      await onDelete(id)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <span className="block text-xs font-medium">{t('playground.memoryHeading')}</span>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t('playground.memoryHelp')}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="playground-memory" className="flex-1 text-xs">
          {t('playground.memoryToggle')}
        </label>
        <Switch
          id="playground-memory"
          size="sm"
          checked={enabled}
          onCheckedChange={onEnabledChange}
          disabled={busy}
        />
      </div>

      {enabled && (
        <div className="space-y-2">
          <div className="space-y-1">
            <span className="block text-[11px] font-medium text-muted-foreground">
              {t('playground.memoryAutoHeading')}
            </span>
            {memories.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{t('playground.memoryEmpty')}</p>
            ) : (
              <ul className="space-y-1.5">
                {memories.map(memory => (
                  <li
                    key={memory.id}
                    className="group flex items-start gap-1.5 rounded-lg border bg-background/60 px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1 text-[11px] leading-snug break-words">
                      {memory.content}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 shrink-0 opacity-70 group-hover:opacity-100"
                      onClick={() => void remove(memory.id)}
                      disabled={deletingId === memory.id || busy}
                      aria-label={t('playground.memoryDelete')}
                      title={t('playground.memoryDelete')}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <details className="rounded-lg border bg-background/40 px-2 py-1.5">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              {t('playground.memoryAddOptional')}
            </summary>
            <div className="mt-2 flex items-start gap-1.5">
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value.slice(0, MAX_MEMORY_LEN))}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void add()
                  }
                }}
                placeholder={t('playground.memoryAddPlaceholder')}
                rows={2}
                disabled={saving || busy}
                className="min-h-[52px] w-full resize-y rounded-lg border bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring/50 disabled:opacity-50"
              />
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="mt-0.5 size-8 shrink-0"
                onClick={() => void add()}
                disabled={!draft.trim() || saving || busy}
                aria-label={t('playground.memoryAdd')}
                title={t('playground.memoryAdd')}
              >
                <Plus className="size-3.5" />
              </Button>
            </div>
          </details>
        </div>
      )}
    </div>
  )
}
