import { useMemo, useState } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { LARGE_SKILL_CONTEXT_TOKENS, MAX_ACTIVE_SKILLS, activeTokens, formatTokens, type SkillIndex } from '@/lib/skills'

// The skill picker: every skill with what it costs in tokens, up to
// MAX_ACTIVE_SKILLS switched on at once. It only edits the selection; the page
// owns the state and what is sent.
export function SkillsDialog({ open, onOpenChange, index, failed, active, onToggle, onClear }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  index: SkillIndex | null
  failed: boolean
  active: string[]
  onToggle: (id: string) => void
  onClear: () => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = index?.skills ?? []
    if (!needle) return all
    return all.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(needle))
  }, [index, query])

  const tokens = activeTokens(active, index)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-2xl">
        <DialogTitle>{t('playground.skillsTitle')}</DialogTitle>
        <DialogDescription className="mt-1">{t('playground.skillsDescription', { max: MAX_ACTIVE_SKILLS })}</DialogDescription>

        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('playground.skillsSearch')}
          aria-label={t('playground.skillsSearch')}
          className="mt-4"
        />

        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{t('playground.skillsActive', { count: active.length, tokens: formatTokens(tokens) })}</span>
          {active.length > 0 && (
            <Button type="button" variant="ghost" size="xs" onClick={onClear}>{t('playground.skillsClear')}</Button>
          )}
        </div>
        {tokens > LARGE_SKILL_CONTEXT_TOKENS && (
          <p className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            {t('playground.skillsLarge')}
          </p>
        )}

        {failed && <p className="mt-4 text-sm text-destructive">{t('playground.skillsUnavailable')}</p>}
        {!failed && !index && <p className="mt-4 text-sm text-muted-foreground">…</p>}
        {index && visible.length === 0 && <p className="mt-4 text-sm text-muted-foreground">{t('playground.skillsNone')}</p>}

        <ul className="mt-3 space-y-1.5" role="listbox" aria-multiselectable="true" aria-label={t('playground.skillsTitle')}>
          {visible.map(skill => {
            const on = active.includes(skill.id)
            return (
              <li key={skill.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => onToggle(skill.id)}
                  className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${on ? 'border-foreground/40 bg-muted/40' : ''}`}
                >
                  <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${on ? 'border-foreground bg-foreground text-background' : 'border-input'}`}>
                    {on && <Check className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="truncate font-mono text-sm">{skill.name}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">~{formatTokens(skill.tokens)}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{skill.description}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        {index && (
          <p className="mt-4 text-[11px] text-muted-foreground">
            {t('playground.skillsAttribution', { author: index.source.author, license: index.source.license })}{' '}
            <a href={index.source.repo} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
              {index.source.repo.replace('https://github.com/', '')}
            </a>
          </p>
        )}
      </DialogPopup>
    </Dialog>
  )
}
