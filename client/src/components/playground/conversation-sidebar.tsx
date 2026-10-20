import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  FolderPlus,
  History,
  LayoutGrid,
  LogOut,
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AppNavFooter, APP_NAME, isDesktopApp, navItems, navMenus } from '@/components/app-nav'
import { Tooltip } from '@/components/tooltip'
import type { ConversationSummary, Project } from '@/lib/playground-conversations'
import {
  readCollapsedProjectIds,
  writeCollapsedProjectIds,
} from '@/lib/playground-conversations'
import { logout } from '@/lib/api'
import { useI18n } from '@/i18n'

// The Playground's saved-conversation rail, laid out like a Gemini-style
// sidebar: brand + tools up top, the chat list in the middle, collapse at the
// edge. Open and collapsed are the same box at two widths; both layers keep a
// fixed width so nothing reflows while the rail animates.

const LAYER =
  'absolute inset-y-0 start-0 flex flex-col transition-[opacity,visibility] duration-200 ease-out motion-reduce:transition-none'

const LOGO_FULL = `${import.meta.env.BASE_URL}brand/xplication-logo.png`
const LOGO_ICON = `${import.meta.env.BASE_URL}brand/xplication-icon.png`

const navBtn =
  'flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm text-foreground/90 transition-colors hover:bg-muted/70'
const iconBtn =
  'flex size-9 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-muted/70'

export function ConversationSidebar({
  conversations,
  projects,
  activeId,
  open,
  onToggle,
  onNew,
  onSelect,
  onRename,
  onExport,
  onDelete,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onMoveConversation,
  onOpenSettings,
}: {
  conversations: ConversationSummary[]
  projects: Project[]
  activeId: number | null
  open: boolean
  onToggle: () => void
  onNew: () => void
  onSelect: (id: number) => void
  onRename: (id: number, title: string) => void
  /** Download the conversation as a Markdown file. */
  onExport: (id: number) => void
  onDelete: (id: number) => void
  onCreateProject: (name: string) => void
  onRenameProject: (id: number, name: string) => void
  onDeleteProject: (id: number) => void
  onMoveConversation: (id: number, projectId: number | null) => void
  onOpenSettings: () => void
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renamingProjectId, setRenamingProjectId] = useState<number | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [armedDeleteId, setArmedDeleteId] = useState<number | null>(null)
  const [armedProjectDeleteId, setArmedProjectDeleteId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [projectDraft, setProjectDraft] = useState('')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [collapsedProjects, setCollapsedProjects] = useState<Set<number>>(
    () => readCollapsedProjectIds(),
  )
  const renameRef = useRef<HTMLInputElement>(null)
  const projectRenameRef = useRef<HTMLInputElement>(null)
  const projectCreateRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Enter commits then the input blurs; without this guard both would create.
  const creatingProjectRef = useRef(false)

  useEffect(() => {
    if (renamingId !== null) renameRef.current?.select()
  }, [renamingId])

  useEffect(() => {
    if (renamingProjectId !== null) projectRenameRef.current?.select()
  }, [renamingProjectId])

  useEffect(() => {
    creatingProjectRef.current = creatingProject
    if (creatingProject) projectCreateRef.current?.select()
  }, [creatingProject])

  useEffect(() => {
    if (searching) searchRef.current?.focus()
  }, [searching])

  useEffect(() => {
    if (!open) {
      setSearching(false)
      setQuery('')
      setCreatingProject(false)
      setProjectDraft('')
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

  const startRenameProject = (project: Project) => {
    setRenamingProjectId(project.id)
    setProjectDraft(project.name)
  }

  const commitRenameProject = () => {
    if (renamingProjectId === null) return
    const name = projectDraft.trim()
    const previous = projects.find(p => p.id === renamingProjectId)
    setRenamingProjectId(null)
    setProjectDraft('')
    if (name && name !== previous?.name) onRenameProject(renamingProjectId, name)
  }

  const commitCreateProject = () => {
    if (!creatingProjectRef.current) return
    creatingProjectRef.current = false
    const name = projectDraft.trim()
    setCreatingProject(false)
    setProjectDraft('')
    if (name) onCreateProject(name)
  }

  const toggleProject = (id: number) => {
    setCollapsedProjects(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writeCollapsedProjectIds(next)
      return next
    })
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return conversations
    return conversations.filter(c =>
      (c.title || t('playgroundSessions.untitled')).toLowerCase().includes(needle),
    )
  }, [conversations, query, t])

  const ungrouped = useMemo(
    () => visible.filter(c => c.projectId == null),
    [visible],
  )

  const byProject = useMemo(() => {
    const map = new Map<number, ConversationSummary[]>()
    for (const c of visible) {
      if (c.projectId == null) continue
      const list = map.get(c.projectId)
      if (list) list.push(c)
      else map.set(c.projectId, [c])
    }
    return map
  }, [visible])

  const stopSearching = () => {
    setSearching(false)
    setQuery('')
  }

  // Search toggles: first click opens (and expands the rail if needed),
  // second click closes. Escape / collapsing the rail still clears it.
  const toggleSearch = () => {
    if (searching) {
      stopSearching()
      return
    }
    setSearching(true)
    if (!open) onToggle()
  }

  const openRail = () => {
    if (!open) onToggle()
  }

  const renderConversation = (conversation: ConversationSummary) => {
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
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => startRename(conversation)}>
                  <Pencil />
                  {t('playgroundSessions.rename')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExport(conversation.id)}>
                  <Download />
                  {t('playgroundSessions.export')}
                </DropdownMenuItem>
                {(projects.length > 0 || conversation.projectId != null) && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Folder className="size-4" />
                      {t('playgroundSessions.moveToProject')}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-40">
                      {conversation.projectId != null && (
                        <DropdownMenuItem
                          onClick={() => onMoveConversation(conversation.id, null)}
                        >
                          {t('playgroundSessions.noProject')}
                        </DropdownMenuItem>
                      )}
                      {projects.map(project => (
                        <DropdownMenuItem
                          key={project.id}
                          disabled={conversation.projectId === project.id}
                          onClick={() => onMoveConversation(conversation.id, project.id)}
                        >
                          {project.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
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
  }

  return (
    <div
      className={`relative shrink-0 overflow-hidden border-e border-border/40 bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        open ? 'w-64' : 'w-14'
      }`}
    >
      {/* ── Collapsed strip: Gemini-style icon rail ───────────────────── */}
      <div
        className={`${LAYER} w-14 items-center px-2.5 py-3 ${
          open ? 'invisible opacity-0' : 'visible opacity-100'
        }`}
      >
        <div className="flex flex-col items-center gap-1">
          <Tooltip text={t('playgroundSessions.showSidebar')} side="right">
            <button
              type="button"
              onClick={onToggle}
              className={`${iconBtn} group relative`}
              aria-label={t('playgroundSessions.showSidebar')}
            >
              <img
                src={LOGO_ICON}
                alt=""
                className="size-7 object-contain transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                draggable={false}
              />
              <PanelLeft className="absolute size-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            </button>
          </Tooltip>
          <Tooltip text={t('playgroundSessions.newChat')} side="right">
            <button
              type="button"
              onClick={onNew}
              className={iconBtn}
              aria-label={t('playgroundSessions.newChat')}
            >
              <SquarePen className="size-4" />
            </button>
          </Tooltip>
          <Tooltip text={t('playgroundSessions.searchChats')} side="right">
            <button
              type="button"
              onClick={toggleSearch}
              className={iconBtn}
              aria-label={t('playgroundSessions.searchChats')}
            >
              <Search className="size-4" />
            </button>
          </Tooltip>
          <Tooltip text={t('nav.openMenu')} side="right">
            <DropdownMenu>
              <DropdownMenuTrigger
                className={iconBtn}
                aria-label={t('nav.openMenu')}
              >
                <LayoutGrid className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start" className="w-48">
                {navItems.map((item) => {
                  const menu = navMenus[item.to]
                  if (menu) {
                    return (
                      <DropdownMenuSub key={item.to}>
                        <DropdownMenuSubTrigger>
                          {t(item.labelKey)}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-48">
                          {menu.items.map((entry) => (
                            <DropdownMenuItem
                              key={entry.to}
                              onClick={() => navigate(entry.to)}
                            >
                              {t(entry.labelKey)}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )
                  }
                  return (
                    <DropdownMenuItem
                      key={item.to}
                      onClick={() => navigate(item.to)}
                      className={location.pathname === item.to ? 'bg-muted' : undefined}
                    >
                      {t(item.labelKey)}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </Tooltip>
          <Tooltip text={t('playgroundSessions.allChats')} side="right">
            <button
              type="button"
              onClick={openRail}
              className={iconBtn}
              aria-label={t('playgroundSessions.allChats')}
            >
              <History className="size-4" />
            </button>
          </Tooltip>
        </div>

        <div className="min-h-0 flex-1" />

        <div className="flex flex-col items-center gap-1">
          <Tooltip text={t('nav.settings')} side="right">
            <button
              type="button"
              onClick={onOpenSettings}
              className={iconBtn}
              aria-label={t('nav.settings')}
            >
              <Settings className="size-4" />
            </button>
          </Tooltip>
          {!isDesktopApp && (
            <Tooltip text={t('nav.signOut')} side="right">
              <button
                type="button"
                onClick={() => logout()}
                className={iconBtn}
                aria-label={t('nav.signOut')}
              >
                <LogOut className="size-4" />
              </button>
            </Tooltip>
          )}
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
            aria-label={APP_NAME}
          >
            <img
              src={LOGO_FULL}
              alt={APP_NAME}
              className="h-8 w-auto max-w-full object-contain object-left brightness-0 dark:brightness-100"
              draggable={false}
            />
          </Link>
          <button
            type="button"
            onClick={toggleSearch}
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
          {searching && (
            <div className="px-1 pb-1">
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
          <button type="button" onClick={onNew} className={navBtn}>
            <SquarePen className="size-4 shrink-0" />
            <span className="truncate">{t('playgroundSessions.newChat')}</span>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-3 pb-2">
          {/* ── Projects ──────────────────────────────────────────────── */}
          <div className="mb-3">
            <div className="mb-1 flex shrink-0 items-center justify-between gap-1 px-3">
              <span className="text-xs font-medium tracking-wide text-muted-foreground">
                {t('playgroundSessions.projects')}
              </span>
              <button
                type="button"
                onClick={() => {
                  creatingProjectRef.current = true
                  setCreatingProject(true)
                  setProjectDraft('')
                }}
                className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                aria-label={t('playgroundSessions.newProject')}
                title={t('playgroundSessions.newProject')}
              >
                <FolderPlus className="size-3.5" />
              </button>
            </div>

            {creatingProject && (
              <div className="mb-1 px-1">
                <input
                  ref={projectCreateRef}
                  value={projectDraft}
                  onChange={e => setProjectDraft(e.target.value)}
                  onBlur={commitCreateProject}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); commitCreateProject() }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      creatingProjectRef.current = false
                      setCreatingProject(false)
                      setProjectDraft('')
                    }
                  }}
                  aria-label={t('playgroundSessions.projectNamePlaceholder')}
                  placeholder={t('playgroundSessions.projectNamePlaceholder')}
                  className="w-full rounded-full border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
                />
              </div>
            )}

            <ul className="space-y-0.5">
              {projects.map(project => {
                const expanded = !collapsedProjects.has(project.id)
                const chats = byProject.get(project.id) ?? []
                const armedProject = armedProjectDeleteId === project.id
                return (
                  <li key={project.id}>
                    {renamingProjectId === project.id ? (
                      <input
                        ref={projectRenameRef}
                        value={projectDraft}
                        onChange={e => setProjectDraft(e.target.value)}
                        onBlur={commitRenameProject}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); commitRenameProject() }
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            setRenamingProjectId(null)
                            setProjectDraft('')
                          }
                        }}
                        aria-label={t('playgroundSessions.projectNamePlaceholder')}
                        placeholder={t('playgroundSessions.projectNamePlaceholder')}
                        className="w-full rounded-full border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
                      />
                    ) : (
                      <div className="group flex items-center gap-0.5 rounded-full pe-0.5 transition-colors hover:bg-muted/60">
                        <button
                          type="button"
                          onClick={() => toggleProject(project.id)}
                          onDoubleClick={() => startRenameProject(project)}
                          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                        >
                          {expanded
                            ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                            : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
                          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate text-sm">{project.name}</span>
                        </button>
                        <DropdownMenu
                          onOpenChange={menuOpen => {
                            if (!menuOpen) setArmedProjectDeleteId(null)
                          }}
                        >
                          <DropdownMenuTrigger
                            className={`${buttonVariants({ variant: 'ghost', size: 'icon-xs' })} shrink-0 rounded-full opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100 data-pressed:opacity-100`}
                            aria-label={t('playgroundSessions.renameProject')}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem onClick={() => startRenameProject(project)}>
                              <Pencil />
                              {t('playgroundSessions.rename')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              closeOnClick={armedProject}
                              onClick={() => {
                                if (armedProject) {
                                  setArmedProjectDeleteId(null)
                                  onDeleteProject(project.id)
                                } else {
                                  setArmedProjectDeleteId(project.id)
                                }
                              }}
                            >
                              <Trash2 />
                              {armedProject
                                ? t('playgroundSessions.deleteProjectConfirm')
                                : t('playgroundSessions.deleteProject')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                    {expanded && (
                      <ul className="ms-3 space-y-0.5 border-s border-border/40 ps-1.5">
                        {chats.length === 0 ? (
                          <li className="px-3 py-2 text-xs text-muted-foreground">
                            {t('playgroundSessions.emptyProject')}
                          </li>
                        ) : (
                          chats.map(renderConversation)
                        )}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>

          {/* ── Ungrouped chats ───────────────────────────────────────── */}
          <div className="mb-1 flex shrink-0 items-center justify-between px-3">
            <span className="text-xs font-medium tracking-wide text-muted-foreground">
              {t('playgroundSessions.allChats')}
            </span>
          </div>

          {conversations.length === 0 && projects.length === 0 && !creatingProject ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              {t('playgroundSessions.empty')}
            </p>
          ) : visible.length === 0 && query.trim() ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              {t('playgroundSessions.searchEmpty')}
            </p>
          ) : ungrouped.length === 0 ? null : (
            <ul className="space-y-0.5">
              {ungrouped.map(renderConversation)}
            </ul>
          )}
        </div>

        <AppNavFooter onOpenSettings={onOpenSettings} />
      </div>
    </div>
  )
}
