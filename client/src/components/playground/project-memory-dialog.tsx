import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pin, PinOff, Plus, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import type { Project } from '@/lib/playground-conversations'
import {
  MAX_INSTRUCTIONS_LEN,
  MAX_PROJECT_MEMORY_LEN,
  addProjectMemory,
  deleteProjectMemory,
  getProjectMemory,
  saveProjectInstructions,
  updateProjectMemory,
  type ProjectMemoryState,
} from '@/lib/project-memory'

// Everything the models remember about one project folder: the standing brief
// the user writes, plus facts the user added or the Playground learned from
// chats in the folder. Pinned facts are always sent first.

export function ProjectMemoryDialog({
  project,
  onClose,
}: {
  project: Project | null
  onClose: () => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const projectId = project?.id ?? null
  const queryKey = ['project-memory', projectId]
  const { data, isLoading } = useQuery<ProjectMemoryState>({
    queryKey,
    queryFn: () => getProjectMemory(projectId!),
    enabled: projectId !== null,
  })
  const [instructions, setInstructions] = useState('')
  const [dirty, setDirty] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (data && !dirty) setInstructions(data.instructions)
  }, [data, dirty])
  useEffect(() => {
    setDirty(false)
    setDraft('')
  }, [projectId])

  const refresh = () => queryClient.invalidateQueries({ queryKey })

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('projectMemory.failed'))
    } finally {
      setBusy(false)
    }
  }

  const saveInstructions = () => run(async () => {
    await saveProjectInstructions(projectId!, instructions)
    setDirty(false)
  })
  const add = () => {
    const content = draft.trim()
    if (!content) return
    void run(async () => {
      await addProjectMemory(projectId!, { content, source: 'manual' })
      setDraft('')
    })
  }

  const memories = data?.memories ?? []

  return (
    <Dialog open={project !== null} onOpenChange={open => { if (!open) onClose() }}>
      <DialogPopup maxWidth="max-w-xl">
        <DialogTitle>{t('projectMemory.title', { name: project?.name ?? '' })}</DialogTitle>
        <DialogDescription className="mt-1">{t('projectMemory.help')}</DialogDescription>

        <div className="mt-4 space-y-1.5">
          <label htmlFor="project-instructions" className="block text-xs font-medium">
            {t('projectMemory.instructions')}
          </label>
          <textarea
            id="project-instructions"
            value={instructions}
            onChange={e => { setInstructions(e.target.value.slice(0, MAX_INSTRUCTIONS_LEN)); setDirty(true) }}
            placeholder={t('projectMemory.instructionsPlaceholder')}
            rows={5}
            className="max-h-64 min-h-[96px] w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {instructions.length}/{MAX_INSTRUCTIONS_LEN}
            </span>
            <Button size="sm" onClick={() => void saveInstructions()} disabled={!dirty || busy}>
              {t('common.save')}
            </Button>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <span className="block text-xs font-medium">{t('projectMemory.facts')}</span>
          {isLoading ? null : memories.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('projectMemory.empty')}</p>
          ) : (
            <ul className="space-y-1.5">
              {memories.map(memory => (
                <li
                  key={memory.id}
                  className="group flex items-start gap-1.5 rounded-lg border bg-background/60 px-2 py-1.5"
                >
                  {memory.source === 'auto' && (
                    <span title={t('projectMemory.learned')} className="mt-0.5 shrink-0 text-muted-foreground">
                      <Sparkles className="size-3" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 text-xs leading-snug break-words">{memory.content}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6 shrink-0"
                    disabled={busy}
                    onClick={() => void run(() => updateProjectMemory(projectId!, memory.id, { pinned: !memory.pinned }))}
                    aria-label={memory.pinned ? t('projectMemory.unpin') : t('projectMemory.pin')}
                    title={memory.pinned ? t('projectMemory.unpin') : t('projectMemory.pin')}
                  >
                    {memory.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6 shrink-0"
                    disabled={busy}
                    onClick={() => void run(() => deleteProjectMemory(projectId!, memory.id))}
                    aria-label={t('playground.memoryDelete')}
                    title={t('playground.memoryDelete')}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-start gap-1.5">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value.slice(0, MAX_PROJECT_MEMORY_LEN))}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add() }
              }}
              placeholder={t('projectMemory.addPlaceholder')}
              rows={2}
              disabled={busy}
              className="min-h-[52px] w-full resize-y rounded-lg border bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring/50 disabled:opacity-50"
            />
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="mt-0.5 size-8 shrink-0"
              onClick={add}
              disabled={!draft.trim() || busy}
              aria-label={t('playground.memoryAdd')}
              title={t('playground.memoryAdd')}
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
