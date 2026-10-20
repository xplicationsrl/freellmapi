import { lazy, Suspense, useState, type CSSProperties, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthGate } from '@/components/auth-gate'
import { AppNavSidebar, isDesktopApp } from '@/components/app-nav'
import { CommandPalette } from '@/components/command-palette'
import { ErrorBoundary } from '@/components/error-boundary'
import { SettingsDialog } from '@/components/settings-dialog'
import { Toaster } from '@/components/toaster'
import { NewBuildPrompt } from '@/components/new-build-prompt'
import { I18nProvider } from '@/i18n'
import { PlaygroundPrefsProvider } from '@/lib/playground-prefs'
import { SettingsUiProvider, useOpenSettings } from '@/lib/settings-ui'
import { toast } from '@/lib/toast'
import { ThemeProvider } from '@/theme'
const KeysPage = lazy(() => import('@/pages/KeysPage'))
const PlaygroundPage = lazy(() => import('@/pages/PlaygroundPage'))
const FallbackPage = lazy(() => import('@/pages/FallbackPage'))
const ModelDetailPage = lazy(() => import('@/pages/ModelDetailPage'))
const FusionPage = lazy(() => import('@/pages/FusionPage'))
const EmbeddingsPage = lazy(() => import('@/pages/EmbeddingsPage'))
const ImagePage = lazy(() => import('@/pages/ImagePage'))
const VideoPage = lazy(() => import('@/pages/VideoPage'))
const AudioPage = lazy(() => import('@/pages/AudioPage'))
const SearchPage = lazy(() => import('@/pages/SearchPage'))
const MediaDetailPage = lazy(() => import('@/pages/MediaDetailPage'))
const EmbeddingDetailPage = lazy(() => import('@/pages/EmbeddingDetailPage'))
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'))
const LogsPage = lazy(() => import('@/pages/LogsPage'))
import NotFoundPage from '@/pages/NotFoundPage'
const AgentsPage = lazy(() => import('@/pages/AgentsPage'))

// Every failed mutation surfaces as an error toast, so no action fails
// silently. A page that already shows the failure inline can opt out with
// `meta: { silenceToast: true }` on the mutation.
const queryClient = new QueryClient({
  // staleTime dedupes the mount storm (#1047) and keeps page-to-page
  // navigation off the network: the Models page alone mounts ~13 queries,
  // several of them the same endpoint from different components, and
  // staleTime 0 refetched every one of them on every navigation and window
  // focus. Cached data renders immediately either way; this only decides
  // whether a background refetch follows. Thirty seconds is shorter than any
  // poller here (refetchInterval still fires on its own clock), and mutations
  // invalidate explicitly, so nothing user-visible goes stale.
  defaultOptions: { queries: { staleTime: 30_000 } },
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.silenceToast) return
      toast.error(error instanceof Error ? error.message : String(error))
    },
  }),
})

const desktopPlatform = typeof window !== 'undefined'
  ? (window as Window & { __FREEAPI_PLATFORM__?: string }).__FREEAPI_PLATFORM__
  : undefined

const isMacDesktop = isDesktopApp && (
  desktopPlatform ? desktopPlatform === 'darwin' : (typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent))
)

// The preload's own early classList.add can be lost (it may run before this
// document exists), so the client claims the class itself at module load —
// before the first React paint — keeping html.desktop CSS (transparent body,
// glass backdrop on macOS) reliable.
if (isDesktopApp) {
  document.documentElement.classList.add('desktop')
  if (isMacDesktop) {
    document.documentElement.classList.add('desktop-mac')
  }
}

// Mac desktop needs a drag region for the traffic lights; everywhere else the
// chrome lives in the left rail and there is nothing to put in a top bar.
function DesktopDragBar() {
  if (!isMacDesktop) return null
  return (
    <div
      className="sticky top-0 z-40 h-[52px] shrink-0 border-b bg-background/45 backdrop-blur"
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
      aria-hidden
    />
  )
}

// Keyed by pathname so navigating away from a crashed page resets the boundary.
function PageBoundary({ children }: { children: ReactNode }) {
  const location = useLocation()
  return <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>
}

// Routes that own the whole viewport instead of sitting in the shell's centred,
// padded column. Only the Playground so far: its columns run edge to edge
// and the transcript scrolls inside its own pane, so the page must be exactly
// as tall as what is left under any desktop drag bar — not a centred card.
const FULL_BLEED_ROUTES = new Set(['/playground'])

// The shell's content container. A full-bleed route drops the max-width and the
// padding and becomes a flex child that fills the rest of the screen; every
// other route gets a centred column that is always exactly max-w-6xl wide.
//
// `w-full` is load-bearing, not decoration. This <main> is an item of a COLUMN
// flex container, so its cross axis is the horizontal one — and flexbox only
// stretches an item across the cross axis when neither cross-axis margin is
// auto (CSS Flexbox §9.6). `mx-auto` sets both, so without an explicit width
// the column shrink-to-fits its content instead: the page is only ever as wide
// as the widest thing that has finished rendering. On a page that fills in from
// several independent queries — Analytics fires ten — that turns every arriving
// response into a visible horizontal jump as the column re-fits, and pages
// whose content never reaches 72rem (Analytics) settle narrower than
// they were designed to be. A definite width makes the column 72rem from the
// first paint, and `mx-auto` goes back to only centring it.
function PageContainer({ children }: { children: ReactNode }) {
  const location = useLocation()
  const fullBleed = FULL_BLEED_ROUTES.has(location.pathname)
  return (
    <main className={fullBleed ? 'flex min-h-0 flex-1 flex-col' : 'mx-auto w-full max-w-6xl px-6 py-8'}>
      {children}
    </main>
  )
}

function ShellBody({ children }: { children: ReactNode }) {
  const location = useLocation()
  const fullBleed = FULL_BLEED_ROUTES.has(location.pathname)
  const openSettings = useOpenSettings()
  // Playground owns its conversation sidebar (with the same nav footer). Other
  // routes get a slim left rail so Models / Keys / … stay reachable without a
  // top hamburger.
  return (
    <div className="flex min-h-0 flex-1">
      {!fullBleed && <AppNavSidebar onOpenSettings={openSettings} />}
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${fullBleed ? '' : 'overflow-y-auto'}`}>
        {children}
      </div>
    </div>
  )
}

// Every route keeps the shell within the viewport. Padded pages scroll in
// ShellBody's content pane so long pages cannot push the sidebar footer away.
// Playground keeps scrolling inside its own transcript pane.
function AppShell({ children }: { children: ReactNode }) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <SettingsUiProvider openSettings={() => setSettingsOpen(true)}>
      <div className={`flex flex-col h-dvh overflow-hidden ${isMacDesktop ? 'desktop-backdrop' : 'bg-background'}`}>
        <DesktopDragBar />
        <ShellBody>{children}</ShellBody>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </div>
    </SettingsUiProvider>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <PlaygroundPrefsProvider>
            <BrowserRouter basename={import.meta.env.BASE_URL}>
              <AuthGate>
                <AppShell>
                  <PageContainer>
                    <PageBoundary>
                      <Suspense fallback={null}>
                        <Routes>
                          <Route path="/" element={<Navigate to="/playground" replace />} />
                          <Route path="/models" element={<Navigate to="/models/chat" replace />} />
                          <Route path="/models/chat" element={<FallbackPage />} />
                          <Route path="/models/chat/:id" element={<ModelDetailPage />} />
                          <Route path="/models/fusion" element={<FusionPage />} />
                          <Route path="/models/embeddings" element={<EmbeddingsPage />} />
                          <Route path="/models/embeddings/:id" element={<EmbeddingDetailPage />} />
                          <Route path="/models/image" element={<ImagePage />} />
                          <Route path="/models/image/:id" element={<MediaDetailPage modality="image" />} />
                          <Route path="/models/video" element={<VideoPage />} />
                          <Route path="/models/video/:id" element={<MediaDetailPage modality="video" />} />
                          <Route path="/models/audio" element={<AudioPage />} />
                          <Route path="/models/audio/:id" element={<MediaDetailPage modality="audio" />} />
                          <Route path="/models/transcription/:id" element={<MediaDetailPage modality="transcription" />} />
                          <Route path="/models/search" element={<SearchPage />} />
                          <Route path="/playground" element={<PlaygroundPage />} />
                          <Route path="/keys" element={<KeysPage />} />
                          <Route path="/agents" element={<AgentsPage />} />
                          <Route path="/fallback" element={<Navigate to="/models/chat" replace />} />
                          <Route path="/analytics" element={<AnalyticsPage />} />
                          <Route path="/logs" element={<LogsPage />} />
                          <Route path="/premium" element={<Navigate to="/playground" replace />} />
                          <Route path="/test" element={<Navigate to="/playground" replace />} />
                          <Route path="/health" element={<Navigate to="/keys" replace />} />
                          <Route path="*" element={<NotFoundPage />} />
                        </Routes>
                      </Suspense>
                    </PageBoundary>
                  </PageContainer>
                  <Toaster />
                  <CommandPalette />
                  <NewBuildPrompt />
                </AppShell>
              </AuthGate>
            </BrowserRouter>
          </PlaygroundPrefsProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

export default App
