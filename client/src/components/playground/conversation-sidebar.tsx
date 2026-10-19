import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronsLeft, ChevronsRight, MoreHorizontal, Pencil, Search, SquarePen, Trash2 } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ConversationSummary } from '@/lib/playground-conversations'
import { useI18n } from '@/i18n'

// The Playground's saved-conversation rail. Collapses to a narrow strip (the
// toggle and "new chat" stay reachable) so a long transcript can have the whole
// width when you want it; the open/closed choice is remembered by the page.
//
// Open and collapsed are the same box at two widths. The container animates its
// width and clips; both layers inside keep a FIXED width and are laid over each
// other, so nothing reflows or squishes while the rail moves. Whichever layer is
// not in use fades out and ends `invisible`, which also takes it out of the tab
// order and the accessibility tree. A reader who asked for less motion gets the
// old instant snap.
//
// Deliberately dumb: every mutation is handed up to PlaygroundPage, which owns
// the active conversation, the transcript, and the saving. All this does is
// list, select, rename in place, and confirm a delete.

// Both layers sit on top of each other inside the animated container; only the
// width and the fade differ.
const LAYER =
  'absolute inset-y-0 start-0 flex flex-col transition-[opacity,visibility] duration-200 ease-out motion-reduce:transition-none'

export function ConversationSidebar({
  conversations,
  activeId,
  open,
  onToggle,
  onNew,
  onSelect,
  onRename,
  onDelete,
}: {
  conversations: ConversationSummary[]
  activeId: number | null
  open: boolean
  onToggle: () => void
  onNew: () => void
  onSelect: (id: number) => void
  onRename: (id: number, title: string) => void
  onDelete: (id: number) => void
}) {
  const { t } = useI18n()
  const [renamingId, setRenamingId] = useState<number | null>(null)
  // Which row's Delete is armed (first click); cleared when its menu closes.
  const [armedDeleteId, setArmedDeleteId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Re-render once a minute so "2m ago" doesn't quietly go stale while a long
  // answer streams.
  const [, setTick] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => setTick(n => n + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (renamingId !== null) renameRef.current?.select()
  }, [renamingId])

  useEffect(() => {
    if (searching) searchRef.current?.focus()
  }, [searching])

  // Closing the rail drops the search UI so the next open starts clean.
  useEffect(() => {
    if (!open) {
      setSearching(false)
      setQuery('')
    }
  }, [open])

  const startRename = (conversation: ConversationSummary) => {
    setRenamingId(conversation.id)
    setDraft(conversation.title)
  }

  const commitRename = () => {
    if (renamingId === null) return
    const title = draft.trim()
    const previous = conversations.find(c => c.id === renamingId)
    setRenamingId(null)
    // An empty box is a cancel, not a request for a nameless conversation.
    if (title && title !== previous?.title) onRename(renamingId, title)
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return conversations
    return conversations.filter(c =>
      (c.title || t('playgroundSessions.untitled')).toLowerCase().includes(needle),
    )
  }, [conversations, query, t])

  const stopSearching = () => {
    setSearching(false)
    setQuery('')
  }

  return (
    <div
      className={`relative shrink-0 overflow-hidden border-e bg-card transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        open ? 'w-60' : 'w-11'
      }`}
    >
      <div
        className={`${LAYER} w-11 items-center gap-1 py-3 ${
          open ? 'invisible opacity-0' : 'visible opacity-100'
        }`}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => { onToggle(); setSearching(true) }}
          aria-label={t('playgroundSessions.searchChats')}
          title={t('playgroundSessions.searchChats')}
        >
          <Search className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onNew}
          aria-label={t('playgroundSessions.newChat')}
          title={t('playgroundSessions.newChat')}
        >
          <SquarePen className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="mt-auto"
          onClick={onToggle}
          aria-label={t('playgroundSessions.showSidebar')}
          title={t('playgroundSessions.showSidebar')}
        >
          <ChevronsRight className="size-4" />
        </Button>
      </div>

      <div
        className={`${LAYER} w-60 ${open ? 'visible opacity-100' : 'invisible opacity-0'}`}
      >
        {/* Search above New chat; the collapse control lives at the foot of
            the rail so the list keeps the space between them. */}
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/40 px-2 pt-2 pb-2">
          {searching ? (
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { e.preventDefault(); stopSearching() }
              }}
              aria-label={t('playgroundSessions.searchChats')}
              placeholder={t('playgroundSessions.searchPlaceholder')}
              className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
            />
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-center gap-2"
              onClick={() => setSearching(true)}
            >
              <Search className="size-4" />
              <span className="truncate">{t('playgroundSessions.searchChats')}</span>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-center gap-2"
            onClick={onNew}
          >
            <SquarePen className="size-4" />
            <span className="truncate">{t('playgroundSessions.newChat')}</span>
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {conversations.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t('playgroundSessions.empty')}
            </p>
          ) : visible.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t('playgroundSessions.searchEmpty')}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {visible.map(conversation => {
                const isActive = conversation.id === activeId
                const armed = armedDeleteId === conversation.id
                return (
                  <li key={conversation.id}>
                    {renamingId === conversation.id ? (
                      <input
                        ref={renameRef}
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                          if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
                        }}
                        aria-label={t('playgroundSessions.renamePlaceholder')}
                        placeholder={t('playgroundSessions.renamePlaceholder')}
                        className="w-full rounded-lg border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
                      />
                    ) : (
                      <div
                        className={`group flex items-center gap-0.5 rounded-lg pr-0.5 transition-colors ${
                          isActive ? 'bg-muted' : 'hover:bg-muted/60'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => onSelect(conversation.id)}
                          onDoubleClick={() => startRename(conversation)}
                          className="min-w-0 flex-1 px-2 py-1.5 text-left"
                        >
                          <span className="block truncate text-sm">
                            {conversation.title || t('playgroundSessions.untitled')}
                          </span>
                        </button>
                        {/* One "…" per row, shown on hover/focus (and while its
                            menu is open) so the list reads as titles only. Delete
                            arms on the first click and fires on the second, the
                            dashboard's usual two-step, without leaving the menu. */}
                        <DropdownMenu
                          onOpenChange={open => { if (!open) setArmedDeleteId(null) }}
                        >
                          <DropdownMenuTrigger
                            className={`${buttonVariants({ variant: 'ghost', size: 'icon-xs' })} shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100 data-pressed:opacity-100`}
                            aria-label={t('playgroundSessions.actions')}
                            title={t('playgroundSessions.actions')}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem onClick={() => startRename(conversation)}>
                              <Pencil />
                              {t('playgroundSessions.rename')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              closeOnClick={armed}
                              onClick={() => {
                                if (armed) { setArmedDeleteId(null); onDelete(conversation.id) }
                                else setArmedDeleteId(conversation.id)
                              }}
                            >
                              <Trash2 />
                              {armed ? t('common.confirm') : t('common.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end border-t border-border/40 px-2 py-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggle}
            aria-label={t('playgroundSessions.hideSidebar')}
            title={t('playgroundSessions.hideSidebar')}
          >
            <ChevronsLeft className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
