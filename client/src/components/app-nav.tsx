import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ChevronRight, LogOut, Settings } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { logout } from '@/lib/api'
import { useI18n } from '@/i18n'

export const APP_NAME = 'AI Xplication'
const LOGO_FULL = `${import.meta.env.BASE_URL}brand/xplication-logo.png`

// App pages behind the left-rail nav. Playground is the home surface (logo /
// new chat), so it is not listed here.
export const navItems = [
  { to: '/models', labelKey: 'nav.models' },
  { to: '/keys', labelKey: 'nav.keys' },
  { to: '/agents', labelKey: 'nav.agents' },
  // New features are English-only for now: with no locale entry, `t` shows the key.
  { to: '/agent', labelKey: 'Agent chat' },
  { to: '/integrations', labelKey: 'Integrations' },
  { to: '/knowledge', labelKey: 'Knowledge' },
  { to: '/analytics', labelKey: 'nav.analytics' },
] as const

export const modelItems = [
  { to: '/models/chat', labelKey: 'models.chatModelsTab' },
  { to: '/models/embeddings', labelKey: 'models.embeddingsTab' },
  { to: '/models/image', labelKey: 'models.imageTab' },
  { to: '/models/video', labelKey: 'models.videoTab' },
  { to: '/models/audio', labelKey: 'models.audioTab' },
  { to: '/models/decision', labelKey: 'decision.tab' },
  { to: '/models/search', labelKey: 'search.tab' },
  { to: '/models/fusion', labelKey: 'models.fusionTab' },
] as const

export const analyticsItems = [
  { to: '/analytics', labelKey: 'nav.analytics' },
  { to: '/logs', labelKey: 'nav.logs' },
] as const

export const navMenus: Record<
  string,
  { items: readonly { to: string; labelKey: string }[]; isActive: (pathname: string) => boolean }
> = {
  '/models': {
    items: modelItems,
    isActive: (pathname) => pathname.startsWith('/models'),
  },
  '/analytics': {
    items: analyticsItems,
    isActive: (pathname) => pathname.startsWith('/analytics') || pathname.startsWith('/logs'),
  },
}

// True when the dashboard runs inside the desktop shell (Electron preload
// sets this). Desktop signs in with a hidden local account, so it has no
// session to end.
export const isDesktopApp = typeof window !== 'undefined'
  && (window as Window & { __FREEAPI_DESKTOP__?: boolean }).__FREEAPI_DESKTOP__ === true

const navBtn =
  'flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm text-foreground/90 transition-colors hover:bg-muted/70'

/**
 * Models / Keys / Agents / Analytics + Settings / Sign out — lives at the
 * bottom of the left rail (conversation sidebar on Playground, slim rail
 * everywhere else).
 */
export function AppNavFooter({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-t border-border/40 px-2 py-2">
      {navItems.map((item) => {
        const menu = navMenus[item.to]
        if (menu) {
          const active = menu.isActive(location.pathname)
          return (
            <DropdownMenu key={item.to}>
              <DropdownMenuTrigger
                className={`${navBtn} ${active ? 'bg-muted font-medium' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate text-start">{t(item.labelKey)}</span>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="w-48">
                {menu.items.map((entry) => (
                  <DropdownMenuItem key={entry.to} onClick={() => navigate(entry.to)}>
                    {t(entry.labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
        return (
          <button
            key={item.to}
            type="button"
            onClick={() => navigate(item.to)}
            className={`${navBtn} ${location.pathname === item.to ? 'bg-muted font-medium' : ''}`}
          >
            <span className="truncate">{t(item.labelKey)}</span>
          </button>
        )
      })}

      <button type="button" onClick={onOpenSettings} className={navBtn}>
        <Settings className="size-4 shrink-0" />
        <span className="truncate">{t('nav.settings')}</span>
      </button>

      {!isDesktopApp && (
        <button type="button" onClick={() => logout()} className={navBtn}>
          <LogOut className="size-4 shrink-0" />
          <span className="truncate">{t('nav.signOut')}</span>
        </button>
      )}
    </div>
  )
}

/** Slim left rail on non-Playground pages: brand + the same footer nav. */
export function AppNavSidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-e border-border/40 bg-sidebar text-sidebar-foreground">
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
      </div>
      <div className="min-h-0 flex-1" />
      <AppNavFooter onOpenSettings={onOpenSettings} />
    </aside>
  )
}
