import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  LayoutGrid,
  MoreHorizontal,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Search,
  Settings,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ConversationSummary } from '@/lib/playground-conversations'
import { useI18n } from '@/i18n'

// The Playground's saved-conversation rail, laid out like a Gemini-style
// sidebar: brand + tools up top, the chat list in the middle, collapse at the
// edge. Open and collapsed are the same box at two widths; both layers keep a
// fixed width so nothing reflows while the rail animates.

const LAYER =
  'absolute inset-y-0 start-0 flex flex-col transition-[opacity,visibility] duration-200 ease-out motion-reduce:transition-none'

const LOGO_WORDMARK = `${import.meta.env.BASE_URL}brand/xplication-wordmark.png`
const LOGO_ICON = `${import.meta.env.BASE_URL}brand/xplication-icon.png`

const navBtn =
  'flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm text-foreground/90 transition-colors hover:bg-muted/70'
const iconBtn =
  'flex size-9 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-muted/70'

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
  const [armedDeleteId, setArmedDeleteId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId !== null) renameRef.current?.select()
  }, [renamingId])

  useEffect(() => {
    if (searching) searchRef.current?.focus()
  }, [searching])

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

  const openSearch = () => {
    if (!open) onToggle()
    setSearching(true)
  }

  return (
    <div
      className={`relative shrink-0 overflow-hidden border-e border-border/40 bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        open ? 'w-64' : 'w-14'
      }`}
    >
      {/* ── Collapsed strip ───────────────────────────────────────────── */}
      <div
        className={`${LAYER} w-14 items-center gap-1 px-2.5 py-3 ${
          open ? 'invisible opacity-0' : 'visible opacity-100'
        }`}
      >
        <button
          type="button"
          onClick={onToggle}
          className={`${iconBtn} relative`}
          aria-label={t('playgroundSessions.showSidebar')}
          title={t('playgroundSessions.showSidebar')}
        >
          <img
            src={LOGO_ICON}
            alt=""
            className="size-7 object-contain"
            draggable={false}
          />
        </button>

        <button
          type="button"
          onClick={onToggle}
          className={iconBtn}
          aria-label={t('playgroundSessions.showSidebar')}
          title={t('playgroundSessions.showSidebar')}
        >
          <PanelLeft className="size-4" />
        </button>

        <button
          type="button"
          onClick={onNew}
          className={iconBtn}
          aria-label={t('playgroundSessions.newChat')}
          title={t('playgroundSessions.newChat')}
        >
          <SquarePen className="size-4" />
        </button>

        <button
          type="button"
          onClick={openSearch}
          className={iconBtn}
          aria-label={t('playgroundSessions.searchChats')}
          title={t('playgroundSessions.searchChats')}
        >
          <Search className="size-4" />
        </button>

        <Link
          to="/models"
          className={iconBtn}
          aria-label={t('nav.models')}
          title={t('nav.models')}
        >
          <LayoutGrid className="size-4" />
        </Link>

        <div className="mt-auto flex flex-col items-center gap-1">
          <Link
            to="/keys"
            className={iconBtn}
            aria-label={t('nav.keys')}
            title={t('nav.keys')}
          >
            <Settings className="size-4" />
          </Link>
        </div>
      </div>

      {/* ── Expanded panel ────────────────────────────────────────────── */}
      <div
        className={`${LAYER} w-64 ${open ? 'visible opacity-100' : 'invisible opacity-0'}`}
      >
        <div className="flex shrink-0 items-center gap-1 px-3 pt-3 pb-1">
          <Link
            to="/playground"
            className="min-w-0 flex-1 rounded-lg px-1 py-1 transition-opacity hover:opacity-80"
            aria-label="Xplication"
          >
            <img
              src={LOGO_WORDMARK}
              alt="Xplication"
              className="h-7 w-auto max-w-full object-contain object-left brightness-0 dark:brightness-100"
              draggable={false}
            />
          </Link>
          <button
            type="button"
            onClick={() => setSearching(true)}
            className={iconBtn}
            aria-label={t('playgroundSessions.searchChats')}
            title={t('playgroundSessions.searchChats')}
          >
            <Search className="size-4" />
          </button>
          <button
            type="button"
            onClick={onToggle}
            className={iconBtn}
            aria-label={t('playgroundSessions.hideSidebar')}
            title={t('playgroundSessions.hideSidebar')}
          >
            <PanelLeftClose className="size-4" />
          </button>
        </div>

        <div className="flex shrink-0 flex-col gap-0.5 px-2 pt-2 pb-1">
          <button type="button" onClick={onNew} className={navBtn}>
            <SquarePen className="size-4 shrink-0" />
            <span className="truncate">{t('playgroundSessions.newChat')}</span>
          </button>
          <Link to="/models" className={navBtn}>
            <LayoutGrid className="size-4 shrink-0" />
            <span className="truncate">{t('nav.models')}</span>
          </Link>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-2 pt-3">
          <div className="mb-1 flex shrink-0 items-center justify-between px-3">
            <span className="text-xs font-medium tracking-wide text-muted-foreground">
              {t('playgroundSessions.allChats')}
            </span>
          </div>

          {searching && (
            <div className="mb-1.5 px-1">
              <input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') { e.preventDefault(); stopSearching() }
                }}
                aria-label={t('playgroundSessions.searchChats')}
                placeholder={t('playgroundSessions.searchPlaceholder')}
                className="w-full rounded-full border border-border/50 bg-background/50 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
              />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {conversations.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                {t('playgroundSessions.empty')}
              </p>
            ) : visible.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
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
                          className="w-full rounded-full border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
                        />
                      ) : (
                        <div
                          className={`group flex items-center gap-0.5 rounded-full pe-0.5 transition-colors ${
                            isActive ? 'bg-muted' : 'hover:bg-muted/60'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => onSelect(conversation.id)}
                            onDoubleClick={() => startRename(conversation)}
                            className="min-w-0 flex-1 px-3 py-2 text-left"
                          >
                            <span className="block truncate text-sm">
                              {conversation.title || t('playgroundSessions.untitled')}
                            </span>
                          </button>
                          <DropdownMenu
                            onOpenChange={menuOpen => { if (!menuOpen) setArmedDeleteId(null) }}
                          >
                            <DropdownMenuTrigger
                              className={`${buttonVariants({ variant: 'ghost', size: 'icon-xs' })} shrink-0 rounded-full opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100 data-pressed:opacity-100`}
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
        </div>

        <div className="flex shrink-0 items-center gap-1 border-t border-border/40 px-2 py-2">
          <Link to="/keys" className={`${navBtn} flex-1`}>
            <Settings className="size-4 shrink-0" />
            <span className="truncate">{t('nav.keys')}</span>
          </Link>
        </div>
      </div>
    </div>
  )
}
