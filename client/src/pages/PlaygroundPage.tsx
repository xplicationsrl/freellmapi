import { useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, CircleAlert, Code, FileText, Globe, Lightbulb, Mail, Pencil, RefreshCw, Square, ThumbsDown, ThumbsUp, Volume2, X } from 'lucide-react'
import { apiFetch, API_BASE } from '@/lib/api'
import { buildModelOptions } from '@/lib/model-groups'
import type { Chain } from '@/components/chain-manager'
import { Markdown } from '@/components/markdown'
import { ArtifactHostContext } from '@/lib/artifact-host'
import { ArtifactPanel, ARTIFACT_PANEL_TRANSITION_MS } from '@/components/playground/artifact-panel'
import { ARTIFACT_WIDTH_STORAGE_KEY, clampArtifactWidth, readArtifactWidth } from '@/lib/artifact-panel-size'
import { extractArtifacts, type Artifact, type ArtifactKind } from '@/lib/artifacts'
import { CopyButton } from '@/components/copy-button'
import { toast } from '@/lib/toast'
import {
  ACCEPT_ATTRIBUTE,
  AttachmentError,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  attachmentImages,
  classifyFile,
  composeText,
  dataUrlBytes,
  fileExtension,
  formatBytes,
  readImageAttachment,
  readTextAttachment,
  toMessageContent,
  type Attachment,
} from '@/lib/attachments'
import { MessageActionButton, MessageEditor } from '@/components/playground/message-actions'
import { StarterPrompts } from '@/components/playground/starter-prompts'
import { createSpeaker, speechSupported, type Speaker } from '@/lib/speech'
import { conversationToMarkdown, downloadTextFile, exportFilename } from '@/lib/conversation-export'
import { canRegenerate, editedTranscript, lookupText, regenerationBase } from '@/lib/playground-retry'
import { MAX_DOCUMENT_BYTES, extractDocxText, extractPdfText } from '@/lib/document-extract'
import { readChatStream } from '@/lib/playground-stream'
import { ConversationSidebar } from '@/components/playground/conversation-sidebar'
import { LiquidComposer } from '@/components/playground/liquid-composer'
import { usePlaygroundPrefs } from '@/lib/playground-prefs'
import { useOpenSettings } from '@/lib/settings-ui'
import { SearchSources } from '@/components/playground/search-sources'
import { engineChain, searchContextMessage, searchProviderName, type SearchEngine, type SearchResult } from '@/lib/search'
import { ModelMakerIcon } from '@/components/model-maker-icon'
import { composerHasContent } from '@/lib/composer-geometry'
import {
  appendDictation,
  hasTranscription,
  resolveDictationModel,
  type TranscriptionModelRow,
} from '@/lib/transcription'
import { samplingRequestParams } from '@/lib/playground-sampling'
import {
  SIDEBAR_OPEN_KEY,
  autoTitle,
  createConversation,
  deleteConversation,
  getConversation,
  createProject,
  deleteProject,
  listConversations,
  listProjects,
  readActiveConversationId,
  renameProject,
  toStoredMessages,
  updateConversation,
  writeActiveConversationId,
  type ChatMessage,
  type WebSearchMeta,
  type ConversationSummary,
  type FusionPanelEntry,
  type Project,
} from '@/lib/playground-conversations'
import {
  createMemory,
  filterNewMemories,
  listMemories,
  memoryContextMessage,
  memoryExtractPrompt,
  parseExtractedMemories,
  type Memory,
} from '@/lib/playground-memories'
import {
  conversationRecallMessage,
  recallConversations,
} from '@/lib/playground-recall'
import { useI18n } from '@/i18n'

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// A read cut short by Stop is the normal end of a stopped reply, not a
// failure: report the stream as finished so the partial text is kept.
async function readUnlessStopped(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stopped: () => boolean,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read()
  } catch (err) {
    if (stopped() && isAbortError(err)) return { done: true, value: undefined }
    throw err
  }
}

// One SSE frame of a fusion stream: either an additive `_fusion` event, an
// error, or a regular chat-completion chunk.
interface FusionStreamFrame {
  _fusion?: {
    event?: string
    platform: string
    model: string
    status?: FusionPanelEntry['status']
    content?: string
    error?: string
  }
  error?: { message?: string }
  choices?: { delta?: { content?: string } }[]
}

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  canonicalId?: string
  displayName: string
  sizeLabel: string
  intelligenceRank: number
  supportsVision: boolean
  keyCount: number
}

// ChatMessage / FusionPanelEntry now live in lib/playground-conversations.ts:
// the transcript is persisted, so its shape is shared with the storage layer
// rather than owned by this component.

// Render a fusion panel/judge entry as "platform/model", but avoid doubling
// the provider when the model id already carries it (e.g. openrouter/owl-alpha,
// groq/compound) — those would otherwise read "openrouter/openrouter/owl-alpha".
function fusionRouteLabel(p: { platform: string; model: string }): string {
  return p.model.startsWith(`${p.platform}/`) ? p.model : `${p.platform}/${p.model}`
}

// Smooth show/hide for the Playground's tucked-away detail (thinking, web
// sources, the fusion panel). The content stays mounted and the row animates
// from 0fr to 1fr, so it opens to its natural height without measuring;
// `inert` keeps a closed panel's links out of the tab order.
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      data-open={open}
      className="grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none data-[open=false]:opacity-0"
      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

// Collapsible, minimal-font trace shown OUTSIDE the main answer bubble: each
// panel model's raw answer as it streamed in, plus the judge that synthesized
// the final answer. Default-open so you can watch it work; collapse to tuck away.
function FusionTrace({ panel, judge, streaming, answerStarted }: {
  panel: FusionPanelEntry[]
  judge?: { platform: string; model: string } | null
  streaming?: boolean
  answerStarted?: boolean
}) {
  const { t } = useI18n()
  // Open while the panel streams in so you can watch it work; auto-collapse the
  // moment the final answer STARTS streaming (first token in the bubble), so it
  // tucks away as the answer takes over — unless the user manually toggled it.
  const [open, setOpen] = useState(true)
  const touched = useRef(false)
  useEffect(() => {
    if (answerStarted && !touched.current) setOpen(false)
  }, [answerStarted])
  return (
    <div className="w-full text-[10px] leading-snug text-muted-foreground/80">
      <button
        type="button"
        onClick={() => { touched.current = true; setOpen(o => !o) }}
        className="inline-flex items-center gap-1 font-mono hover:text-foreground transition-colors"
      >
        <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        {t('playground.fusionTrace', { count: panel.length })}{streaming ? ' …' : ''}
      </button>
      <Collapse open={open}>
        <div className="mt-1 space-y-2 border-l border-border/60 pl-2.5">
          {panel.map((p, i) => (
            <div key={i} className="space-y-0.5">
              <span className="font-mono font-medium">{fusionRouteLabel(p)}</span>
              {p.status === 'failed'
                ? <span className="ml-1.5 text-amber-600 dark:text-amber-400">{t('playground.fusionFailed')}{p.error ? `: ${p.error}` : ''}</span>
                : p.content
                  ? <div className="whitespace-pre-wrap opacity-80">{p.content}</div>
                  : <span className="ml-1.5 opacity-60">…</span>}
            </div>
          ))}
          {judge && (
            <div className="pt-1.5 border-t border-border/60">
              <span className="font-mono font-medium">{fusionRouteLabel(judge)}</span>
              <span className="ml-1.5 opacity-70">{t('playground.fusionJudgeSynth')}</span>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  )
}

// Thinking tokens, shown INSIDE the assistant bubble above the answer. Same
// visual language as FusionTrace (minimal font, muted, hanging rule, chevron
// toggle) and the same behaviour: open while it streams so you can watch the
// model work, auto-collapsing once the answer itself starts.
function ReplyTrace({ reasoning, search, answerStarted }: {
  reasoning?: string
  search?: WebSearchMeta
  answerStarted?: boolean
}) {
  const { t } = useI18n()
  // Thinking opens while it streams and tucks away once the answer starts.
  // Web sources never open on their own: they are there for the curious, so a
  // searched reply with no thinking starts closed.
  const [open, setOpen] = useState(() => !!reasoning && !answerStarted)
  const touched = useRef(false)
  useEffect(() => {
    if (answerStarted && !touched.current) setOpen(false)
  }, [answerStarted])
  useEffect(() => {
    if (reasoning && !answerStarted && !touched.current) setOpen(true)
  }, [reasoning, answerStarted])
  const sourceCount = search?.sources.length ?? 0
  return (
    <div className="mb-2 text-muted-foreground/80">
      <button
        type="button"
        onClick={() => { touched.current = true; setOpen(o => !o) }}
        aria-expanded={open}
        className="inline-flex items-center gap-1 font-mono text-[10px] leading-snug hover:text-foreground transition-colors"
      >
        <ChevronRight className={`size-3 transition-transform duration-300 ${open ? 'rotate-90' : ''}`} />
        {open ? t('common.hide') : t('common.show')}
        {sourceCount > 0 && (
          <span className="inline-flex items-center gap-1 opacity-80">
            · <Globe className="size-2.5" /> {t('search.traceSources', { count: sourceCount })}
          </span>
        )}
      </button>
      <Collapse open={open}>
        {search && sourceCount > 0 && <SearchSources search={search} />}
        {reasoning && (
          // Same type as the answer beneath it, size and leading, only quieter.
          <div className="mt-1 whitespace-pre-wrap border-l border-border/60 pl-2.5 text-sm leading-relaxed text-muted-foreground">
            {reasoning}
          </div>
        )}
      </Collapse>
    </div>
  )
}

// How close to the bottom of the transcript still counts as "reading the live
// answer", in pixels. Slack is needed either way — sub-pixel scroll positions
// mean an exact comparison never matches — and a couple of lines' worth of it
// keeps the follow from dropping out on a stray trackpad nudge.
const SCROLL_FOLLOW_SLACK = 40

// The conversation sidebar needs room the small breakpoints do not have. So
// below lg a visit starts collapsed whatever a desktop session remembered —
// the toggle still works, the remembered choice just isn't restored until
// there is width for it.
function initialRailOpen(key: string): boolean {
  if (typeof window === 'undefined') return true
  if (!window.matchMedia('(min-width: 1024px)').matches) return false
  return localStorage.getItem(key) !== 'false'
}

// Whether this browser can read text aloud; checked once, it does not change.
const SPEECH_OK = speechSupported()

export default function PlaygroundPage() {
  const { t, locale } = useI18n()
  const openSettings = useOpenSettings()
  const {
    systemPrompt,
    setSystemPrompt,
    sampling,
    webSearch,
    setWebSearch: updateWebSearch,
    memoryEnabled,
    selectedModel,
    setSelectedModel,
    dictationChoice,
  } = usePlaygroundPrefs()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  // The sent message being edited in place, if any.
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null)
  // Files staged for the NEXT message: images already downscaled to a data URI,
  // text-like files already decoded. Cleared on send. (#325)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Whether the transcript should keep itself pinned to the bottom. Every model
  // streams now, so a message can grow for a minute straight — scrolling up to
  // re-read something must not be undone by the next token.
  const followRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  // Cancels the in-flight completion when the user clears the chat, sends
  // again, or navigates away mid-stream.
  const abortRef = useRef<AbortController | null>(null)
  // Set only by the Stop button. An abort without it (new chat, leaving the
  // page) discards the reply; an abort with it ends the reply where it is and
  // keeps what had already arrived.
  const stoppedRef = useRef(false)
  // Read-aloud: which reply is being spoken (by index), and the speaker that
  // owns the browser's one speech queue.
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null)
  const speakerRef = useRef<Speaker | null>(null)
  const stopSpeaking = () => {
    speakerRef.current?.stop()
    setSpeakingIndex(null)
  }

  // ---- Saved conversations -------------------------------------------------
  // The transcript lives on the server now. `conversationId` is the row this
  // page is writing to; null means "nothing sent yet", and no row exists until
  // the first message — a fresh visit still opens on an empty transcript.
  const queryClient = useQueryClient()
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => initialRailOpen(SIDEBAR_OPEN_KEY))
  // Mirrors of state the async save paths read AFTER their closure was made:
  // a stream that started before the row existed still has to save into it.
  const conversationIdRef = useRef<number | null>(null)
  const titleRef = useRef('')
  // Memoised create, so two saves racing at the start of a conversation (a
  // fast first answer and a quick second question) cannot mint two rows.
  const createRef = useRef<Promise<number | null> | null>(null)

  const { data: conversations = [] } = useQuery<ConversationSummary[]>({
    queryKey: ['playground-conversations'],
    queryFn: listConversations,
  })
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['playground-projects'],
    queryFn: listProjects,
  })
  const { data: memories = [] } = useQuery<Memory[]>({
    queryKey: ['playground-memories'],
    queryFn: listMemories,
  })
  const refreshConversations = () => {
    queryClient.invalidateQueries({ queryKey: ['playground-conversations'] })
  }
  const refreshProjects = () => {
    queryClient.invalidateQueries({ queryKey: ['playground-projects'] })
  }
  const refreshMemories = () => {
    queryClient.invalidateQueries({ queryKey: ['playground-memories'] })
  }
  // Stream completions close over stale state; these refs keep extract + inject
  // looking at the latest toggle and list without restarting the request.
  const memoryEnabledRef = useRef(memoryEnabled)
  const memoriesRef = useRef(memories)
  const apiKeyRef = useRef<string | undefined>(undefined)
  useEffect(() => { memoryEnabledRef.current = memoryEnabled }, [memoryEnabled])
  useEffect(() => { memoriesRef.current = memories }, [memories])

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })
  useEffect(() => { apiKeyRef.current = keyData?.apiKey }, [keyData?.apiKey])

  // After a finished exchange, ask the router for NEW durable facts and store
  // any that are not already known. Failures stay silent — memory is a side
  // channel, not part of the answer the user is waiting on.
  const extractMemoriesFromExchange = async (msgs: ChatMessage[]) => {
    if (!memoryEnabledRef.current) return
    const apiKey = apiKeyRef.current
    if (!apiKey) return

    const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant' && !m.isError)
    const lastUser = [...msgs].reverse().find(m => m.role === 'user')
    if (!lastAssistant?.content.trim() || !lastUser?.content.trim()) return

    const existing = memoriesRef.current
    try {
      const res = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'auto',
          stream: false,
          temperature: 0,
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: memoryExtractPrompt(existing, {
              user: lastUser.content,
              assistant: lastAssistant.content,
            }),
          }],
        }),
      })
      if (!res.ok) return
      const data = await res.json()
      const raw = data.choices?.[0]?.message?.content
      if (typeof raw !== 'string') return
      const fresh = filterNewMemories(parseExtractedMemories(raw), existing)
      if (fresh.length === 0) return
      for (const content of fresh) {
        await createMemory(content)
      }
      refreshMemories()
    } catch {
      // Extraction is best-effort; a failed side call must not surface as a chat error.
    }
  }

  // Speech-to-text for the composer's mic: which transcription models can
  // route right now, and which one the user asked for (Auto by default,
  // remembered in localStorage like the chat model).
  const { data: mediaData } = useQuery<{ models: TranscriptionModelRow[] }>({
    queryKey: ['media'],
    queryFn: () => apiFetch('/api/media'),
  })
  const mediaModels = mediaData?.models ?? []

  // Engines that can actually run a search: enabled, with a key behind them.
  // An older server without the endpoint just leaves the switch unavailable.
  const { data: searchEngines = [] } = useQuery<SearchEngine[]>({
    queryKey: ['search-engines'],
    queryFn: () => apiFetch('/api/search/engines'),
    retry: false,
  })
  const usableEngines = engineChain(searchEngines).filter(e => e.keyCount > 0)
  const webSearchAvailable = usableEngines.length > 0
  const webSearchOn = webSearch && webSearchAvailable
  const transcriptionAvailable = hasTranscription(mediaModels)
  const dictationModel = resolveDictationModel(dictationChoice, mediaModels)

  // Artifacts (#playground): runnable code in a reply (HTML, SVG) opens in a
  // side panel with a sandboxed preview next to the source. A card in the
  // reply opens it by hand; a reply that finishes with an artifact opens its
  // first one on its own, once, like the Artifacts pattern users know.
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  // `artifactOpen` drives the slide; the artifact itself stays mounted through
  // the exit animation and is dropped once it has finished.
  const [artifactOpen, setArtifactOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [artifactWidth, setArtifactWidth] = useState<number>(
    () => readArtifactWidth(localStorage.getItem(ARTIFACT_WIDTH_STORAGE_KEY), window.innerWidth),
  )
  const commitArtifactWidth = (w: number) => {
    const next = clampArtifactWidth(w, window.innerWidth)
    setArtifactWidth(next)
    localStorage.setItem(ARTIFACT_WIDTH_STORAGE_KEY, String(next))
  }
  const showArtifact = (a: Artifact) => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    setArtifact(a)
    setArtifactOpen(true)
  }
  const closeArtifact = () => {
    setArtifactOpen(false)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => { setArtifact(null); closeTimer.current = null }, ARTIFACT_PANEL_TRANSITION_MS)
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])
  const openArtifact = useCallback((kind: ArtifactKind, language: string, code: string) => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    setArtifact({
      id: `manual:${code.length}:${code.slice(0, 40)}`,
      kind,
      language,
      code,
      title: /<title[^>]*>([^<]{1,120})<\/title>/i.exec(code)?.[1]?.trim() ?? null,
      filename: kind === 'svg' ? 'artifact.svg' : 'artifact.html',
    })
    setArtifactOpen(true)
  }, [])
  const artifactHost = useMemo(() => ({ open: openArtifact, activeCode: artifact?.code ?? null }), [openArtifact, artifact?.code])
  // Auto-open only for a reply that just finished HERE — not for every old
  // conversation that happens to contain one, which would pop the panel on
  // each visit. `loading` going true→false marks the reply's completion.
  const wasLoadingRef = useRef(false)
  useEffect(() => {
    if (loading) { wasLoadingRef.current = true; return }
    if (!wasLoadingRef.current) return
    wasLoadingRef.current = false
    const idx = messages.length - 1
    const last = messages[idx]
    if (!last || last.role !== 'assistant' || last.isError) return
    const found = extractArtifacts(last.content, idx)
    if (found.length === 0) return
    // Deferred a tick: the open is a consequence of the reply landing, not
    // part of rendering it, and it must not cascade into this commit.
    const timer = setTimeout(() => showArtifact(found[0]), 0)
    return () => clearTimeout(timer)
  }, [loading, messages])

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  // Named fallback chains (#1021). Every custom chain is served as an
  // `auto:<name>` model — /v1/models lists them and the send path already
  // routes them — but the picker only ever offered 'auto', so the one place
  // you could try a chain you had just built was a curl command. The id is
  // derived exactly as the server derives it (routes/proxy.ts).
  const { data: chains = [] } = useQuery<Chain[]>({
    queryKey: ['profiles'],
    queryFn: () => apiFetch('/api/profiles'),
  })
  const chainOptions = chains
    .filter(c => c.type === 'custom')
    .map(c => ({
      value: `auto:${c.name.toLowerCase()}`,
      label: c.emoji ? `${c.emoji} ${c.name}` : c.name,
      sub: `auto:${c.name.toLowerCase()}`,
      isNew: false,
      platforms: [] as string[],
    }))

  // Unification is always on now (the on/off toggle was removed), so the picker
  // always collapses a model's providers into one option.
  const unifyOn = true

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)
  // Collapse the same model from multiple providers into one option (value =
  // canonical id, which the proxy resolves to the whole group).
  const modelOptions = buildModelOptions(availableModels, unifyOn)

  // Picker values that can accept images. A unified option counts as vision-
  // capable when ANY of its providers is, because routing picks a vision member
  // for image requests. Auto/Fusion are never flagged: the server picks the
  // model there (and hard-fails with a clear error if none can see).
  const visionValues = new Set(
    availableModels.filter(e => e.supportsVision).map(e => e.canonicalId ?? e.modelId),
  )
  const pendingImages = attachmentImages(attachments)
  // A chain (`auto:<name>`) is as server-picked as plain auto: the router
  // chooses a vision-capable member for an image request, so the hint would be
  // guesswork about a model that has not been picked yet.
  const modelBlindToImages = pendingImages.length > 0
    && selectedModel !== 'auto' && selectedModel !== 'fusion'
    && !selectedModel.startsWith('auto:')
    && !visionValues.has(selectedModel)

  // Follow the stream only while the reader is parked at the bottom. Judging
  // by direction (rather than position alone) keeps our own smooth-scroll
  // animation — which always travels downwards — from being mistaken for the
  // user taking over, whatever they used to scroll: wheel, keys, or the bar.
  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    lastScrollTopRef.current = el.scrollTop
    const onScroll = () => {
      const top = el.scrollTop
      const movedUp = top < lastScrollTopRef.current - 1
      lastScrollTopRef.current = top
      if (el.scrollHeight - top - el.clientHeight <= SCROLL_FOLLOW_SLACK) followRef.current = true
      else if (movedUp) followRef.current = false
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (followRef.current) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // A stream left running after the page goes away would keep calling
  // setMessages on an unmounted tree (and hold the socket open).
  useEffect(() => () => { abortRef.current?.abort(); speakerRef.current?.stop() }, [])

  // Adopt a conversation the server just handed back as the one this page is
  // writing to, and remember it for the next reload.
  const adoptConversation = (id: number, title: string) => {
    conversationIdRef.current = id
    titleRef.current = title
    setConversationId(id)
    writeActiveConversationId(id)
  }

  // The id to save into, creating the row on the first message. Returns null
  // when the create failed — saving is best-effort, never something that costs
  // you the answer on screen.
  const conversationIdFor = (msgs: ChatMessage[]): Promise<number | null> => {
    if (conversationIdRef.current !== null) return Promise.resolve(conversationIdRef.current)
    if (!createRef.current) {
      createRef.current = createConversation({
        title: autoTitle(msgs),
        messages: toStoredMessages(msgs),
        model: selectedModel,
        systemPrompt: systemPrompt.trim() || null,
      })
        .then(created => {
          adoptConversation(created.id, created.title)
          refreshConversations()
          return created.id
        })
        .catch(err => {
          // Let the next completed exchange try again rather than wedging the
          // page on one bad request.
          createRef.current = null
          console.error('[playground] could not create the conversation', err)
          return null
        })
    }
    return createRef.current
  }

  // Save the whole conversation — transcript, title, model, system prompt — in
  // one PUT. Called when a response FINISHES (never per delta) and on
  // rename/clear. A failure is logged and dropped: the transcript on screen is
  // the source of truth, and the next exchange saves it again.
  const persistConversation = async (msgs: ChatMessage[]) => {
    const id = await conversationIdFor(msgs)
    if (id === null) return
    try {
      const saved = await updateConversation(id, {
        // Auto-title once, from the opening question; a rename makes the title
        // non-empty for good, so it is never recomputed over.
        title: titleRef.current || autoTitle(msgs),
        messages: toStoredMessages(msgs),
        model: selectedModel,
        systemPrompt: systemPrompt.trim() || null,
      })
      if (conversationIdRef.current === id) titleRef.current = saved.title
      refreshConversations()
    } catch (err) {
      console.error('[playground] could not save the conversation', err)
    }
  }

  // Drop everything tied to the current conversation. Shared by "new
  // conversation", "clear", and a stored id that no longer exists.
  const resetConversationState = () => {
    stopSpeaking()
    abortRef.current?.abort()
    abortRef.current = null
    conversationIdRef.current = null
    titleRef.current = ''
    createRef.current = null
    setConversationId(null)
    writeActiveConversationId(null)
    setMessages([])
    setEditing(null)
    setAttachments([])
    followRef.current = true
  }

  // Save whatever is on screen before it goes away — leaving a conversation
  // mid-stream should keep the part that had already arrived. The last
  // completed exchange saved itself; this only ever adds to that.
  const flushCurrentConversation = () => {
    if (messages.length > 0) void persistConversation(messages)
  }

  // Switch to a saved conversation: transcript, model and system prompt all
  // come back, so you land exactly where you left it.
  const openConversation = async (id: number) => {
    stopSpeaking()
    abortRef.current?.abort()
    abortRef.current = null
    const conversation = await getConversation(id)
    createRef.current = null
    setMessages(conversation.messages)
    setEditing(null)
    setAttachments([])
    setSelectedModel(conversation.model ?? 'auto')
    setSystemPrompt(conversation.systemPrompt ?? '')
    adoptConversation(conversation.id, conversation.title)
    followRef.current = true
    inputRef.current?.focus()
  }

  const handleSelectConversation = (id: number) => {
    if (id === conversationIdRef.current) return
    flushCurrentConversation()
    openConversation(id).catch(err => {
      console.error('[playground] could not open the conversation', err)
      toast.error(t('playgroundSessions.loadFailed'))
      refreshConversations()
    })
  }

  // "New conversation" and "Clear" are the same move now: bank the current
  // transcript, then start with a blank one. The old chat stays in the sidebar.
  const handleNewConversation = () => {
    flushCurrentConversation()
    resetConversationState()
    inputRef.current?.focus()
  }

  const handleRenameConversation = (id: number, title: string) => {
    // Title only: a rename must not race the transcript of an in-flight answer
    // away, which is exactly what re-sending messages here would risk.
    updateConversation(id, { title })
      .then(saved => {
        if (conversationIdRef.current === id) titleRef.current = saved.title
        refreshConversations()
      })
      .catch(err => {
        console.error('[playground] could not rename the conversation', err)
        toast.error(t('playgroundSessions.renameFailed'))
      })
  }

  const handleDeleteConversation = (id: number) => {
    deleteConversation(id)
      .then(() => {
        // Deleting the open one leaves the Playground on a blank slate, the
        // same state a first-ever visit gets.
        if (conversationIdRef.current === id) resetConversationState()
        refreshConversations()
      })
      .catch(err => {
        console.error('[playground] could not delete the conversation', err)
        toast.error(t('playgroundSessions.deleteFailed'))
      })
  }

  const handleCreateProject = (name: string) => {
    createProject(name)
      .then(() => refreshProjects())
      .catch(err => {
        console.error('[playground] could not create the project', err)
        toast.error(t('playgroundSessions.projectCreateFailed'))
      })
  }

  const handleRenameProject = (id: number, name: string) => {
    renameProject(id, name)
      .then(() => refreshProjects())
      .catch(err => {
        console.error('[playground] could not rename the project', err)
        toast.error(t('playgroundSessions.projectRenameFailed'))
      })
  }

  const handleDeleteProject = (id: number) => {
    deleteProject(id)
      .then(() => {
        refreshProjects()
        // Chats are unassigned by the server (ON DELETE SET NULL); refresh
        // so they reappear under the flat list.
        refreshConversations()
      })
      .catch(err => {
        console.error('[playground] could not delete the project', err)
        toast.error(t('playgroundSessions.projectDeleteFailed'))
      })
  }

  const handleMoveConversation = (id: number, projectId: number | null) => {
    updateConversation(id, { projectId })
      .then(() => refreshConversations())
      .catch(err => {
        console.error('[playground] could not move the conversation', err)
        toast.error(t('playgroundSessions.moveFailed'))
      })
  }

  const toggleSidebar = () => {
    setSidebarOpen(open => {
      localStorage.setItem(SIDEBAR_OPEN_KEY, String(!open))
      return !open
    })
  }

  // Reopen whatever was on screen before the reload. A stored id that no longer
  // exists (deleted in another tab) just falls back to an empty transcript.
  useEffect(() => {
    const stored = readActiveConversationId()
    if (stored === null) return
    // The state it sets lands after the fetch resolves, not during this body —
    // restoring the session IS synchronising React with an external system.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    openConversation(stored).catch(() => writeActiveConversationId(null))
    // Mount only: this restores the session, it does not track later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Read a fusion SSE stream, updating the assistant message in place as panel
  // answers + the judge arrive (additive `_fusion` frames) and the final answer
  // streams as content deltas.
  const streamFusion = async (stream: ReadableStream<Uint8Array>, baseMessages: ChatMessage[], start: number) => {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let finalContent = ''
    const panel: FusionPanelEntry[] = []
    let judge: { platform: string; model: string } | null = null

    // Returns the transcript it rendered, so the final flush can hand the
    // finished exchange straight to the save without rebuilding it.
    const flush = (streaming: boolean): ChatMessage[] => {
      const next: ChatMessage[] = [...baseMessages, {
        role: 'assistant',
        content: finalContent,
        meta: { latency: Date.now() - start, fusionPanel: [...panel], fusionJudge: judge, fusionStreaming: streaming },
      }]
      setMessages(next)
      return next
    }
    flush(true)

    for (;;) {
      const { done, value } = await readUnlessStopped(reader, () => stoppedRef.current)
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const tl = line.trim()
        if (!tl.startsWith('data:')) continue
        const d = tl.slice(5).trim()
        if (d === '[DONE]') continue
        let obj: FusionStreamFrame
        try { obj = JSON.parse(d) as FusionStreamFrame } catch { continue }
        if (obj._fusion) {
          if (obj._fusion.event === 'panel') {
            panel.push({ platform: obj._fusion.platform, model: obj._fusion.model, status: obj._fusion.status, content: obj._fusion.content, error: obj._fusion.error })
          } else if (obj._fusion.event === 'judge') {
            judge = { platform: obj._fusion.platform, model: obj._fusion.model }
          }
          flush(true)
        } else if (obj.error) {
          finalContent = `${t('playground.errorPrefix')} ${obj.error.message}`
          flush(true)
        } else if (obj.choices) {
          const delta = obj.choices[0]?.delta?.content
          if (delta) { finalContent += delta; flush(true) }
        }
      }
    }
    // The exchange is complete: one save, here, never per delta.
    const finished = flush(false)
    await persistConversation(finished)
    if (!stoppedRef.current) void extractMemoriesFromExchange(finished)
  }

  // Read a plain (non-fusion) OpenAI chat stream, filling the assistant bubble
  // in place as content and reasoning deltas land. The routing metadata is
  // already known — it rides on the response headers, which arrive before the
  // first frame — so the only thing the stream adds is the latency, measured
  // to the last frame rather than to the first.
  const streamChat = async (
    stream: ReadableStream<Uint8Array>,
    baseMessages: ChatMessage[],
    start: number,
    routedVia: string | null,
    fallbackAttempts: string | null,
    webSearchMeta?: WebSearchMeta,
  ) => {
    const via = routedVia
      ? { platform: routedVia.split('/')[0], model: routedVia.split('/').slice(1).join('/') }
      : undefined
    let content = ''
    let reasoning = ''
    let failure: string | null = null

    // Returns the transcript it rendered, so the final flush can hand the
    // finished exchange straight to the save without rebuilding it.
    const flush = (streaming: boolean): ChatMessage[] => {
      const next: ChatMessage[] = [...baseMessages]
      // A stream that broke before the first token has nothing to show but the
      // error; one that broke halfway keeps what it managed to say.
      if (content || reasoning || (failure === null && !stoppedRef.current)) {
        next.push({
          role: 'assistant',
          content,
          ...(reasoning ? { reasoning } : {}),
          ...(streaming ? { streaming: true } : {}),
          meta: {
            platform: via?.platform,
            model: via?.model,
            latency: Date.now() - start,
            fallbackAttempts: fallbackAttempts ? parseInt(fallbackAttempts) : undefined,
            ...(webSearchMeta ? { webSearch: webSearchMeta } : {}),
          },
        })
      }
      if (failure !== null) next.push({ role: 'assistant', isError: true, content: failure })
      setMessages(next)
      return next
    }

    try {
      await readChatStream(stream, {
        onDelta: text => { content += text; flush(true) },
        onReasoning: text => { reasoning += text; flush(true) },
        onError: message => { failure = message; flush(true) },
      })
    } catch (err) {
      // Stop rejects the pending read with an AbortError: the reply simply
      // ends here. Anything else is a real failure.
      if (!(stoppedRef.current && isAbortError(err))) throw err
    }
    // The exchange is complete: one save, here, never per delta.
    const finished = flush(false)
    await persistConversation(finished)
    if (failure === null && !stoppedRef.current) void extractMemoriesFromExchange(finished)
  }

  // Stage dropped/pasted/picked files. Every rejection is reported by name so a
  // silently missing attachment is impossible; accepted files are added in one
  // batch after the async reads settle.
  const addFiles = async (files: File[]) => {
    if (files.length === 0) return
    const accepted: Attachment[] = []
    let imageBytes = pendingImages.reduce((sum, url) => sum + dataUrlBytes(url), 0)

    for (const file of files) {
      if (attachments.length + accepted.length >= MAX_ATTACHMENTS) {
        toast.error(t('playground.attachTooMany', { count: MAX_ATTACHMENTS }))
        break
      }
      const kind = classifyFile(file)
      if (!kind) {
        toast.error(t('playground.attachUnsupported', { name: file.name }))
        continue
      }
      try {
        if (kind === 'image') {
          const dataUrl = await readImageAttachment(file)
          if (imageBytes + dataUrlBytes(dataUrl) > MAX_TOTAL_IMAGE_BYTES) {
            toast.error(t('playground.attachTooLarge', { name: file.name, max: formatBytes(MAX_TOTAL_IMAGE_BYTES) }))
            continue
          }
          imageBytes += dataUrlBytes(dataUrl)
          accepted.push({ id: `${Date.now()}-${accepted.length}-${file.name}`, kind, name: file.name, dataUrl })
        } else if (kind === 'document') {
          const extracted = fileExtension(file.name) === 'docx' || file.type.includes('wordprocessingml')
            ? await extractDocxText(file)
            : await extractPdfText(file)
          if (!extracted) {
            toast.error(t('playground.attachNoText', { name: file.name }))
            continue
          }
          if (extracted.truncated) toast.info(t('playground.attachTruncated', { name: file.name }))
          accepted.push({ id: `${Date.now()}-${accepted.length}-${file.name}`, kind: 'text', name: file.name, text: extracted.text })
        } else {
          const text = await readTextAttachment(file)
          accepted.push({ id: `${Date.now()}-${accepted.length}-${file.name}`, kind, name: file.name, text })
        }
      } catch (err) {
        const reason = err instanceof AttachmentError ? err.reason : 'unreadable'
        toast.error(reason === 'too-large'
          ? t('playground.attachTooLarge', {
              name: file.name,
              max: formatBytes(kind === 'image' ? MAX_IMAGE_BYTES : kind === 'document' ? MAX_DOCUMENT_BYTES : MAX_TEXT_BYTES),
            })
          : t('playground.attachFailed', { name: file.name }))
      }
    }
    if (accepted.length > 0) setAttachments(prev => [...prev, ...accepted])
  }

  const removeAttachment = (id: string) => setAttachments(prev => prev.filter(a => a.id !== id))

  // Produce the assistant reply for `newMessages`, which ends with a user
  // message. Shared by sending, regenerating and edit-and-resend: the callers
  // differ only in how they arrive at that transcript. `text` is what web
  // search and recall look up.
  const runReply = async (newMessages: ChatMessage[], text: string) => {
    // Your own message always brings the transcript back down, however far up
    // you had scrolled to read.
    followRef.current = true
    stopSpeaking()
    setMessages(newMessages)
    setEditing(null)
    stoppedRef.current = false
    setLoading(true)
    inputRef.current?.focus()

    // The server row is born HERE — with the first message, not on arrival at
    // the page — so a visit that sends nothing leaves no trace in the sidebar.
    // Not awaited: the create runs alongside the completion, and every save
    // below waits on the same memoised promise.
    void conversationIdFor(newMessages)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`
      const base = API_BASE

      // Web search first, when it is on and there is a question to look up. A
      // failed search is reported and the question is answered without it.
      let searchContext: string | null = null
      let webSearchMeta: WebSearchMeta | undefined
      if (webSearchOn && text) {
        const searchStart = Date.now()
        try {
          const res = await fetch(`${base}/v1/search`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ query: text, max_results: 5 }),
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
            throw new Error(err.error?.message ?? err.message ?? `HTTP ${res.status}`)
          }
          const found = await res.json() as SearchResult
          if (found.results.length > 0) {
            searchContext = searchContextMessage(found)
            webSearchMeta = {
              engine: searchProviderName(found.provider),
              latency: Date.now() - searchStart,
              sources: found.results.map(r => ({ title: r.title, url: r.url })),
            }
          }
        } catch (err) {
          toast.error(t('search.playgroundFailed', { reason: err instanceof Error ? err.message : String(err) }))
        }
      }

      const isFusion = selectedModel === 'fusion'
      const sysPrompt = systemPrompt.trim()

      // Cross-chat recall first (past discussions), then durable fact bullets.
      // Failures stay silent — recall is a side channel, like extraction.
      let recallContext = ''
      if (memoryEnabled && text) {
        try {
          const recalled = await recallConversations({
            query: text,
            excludeConversationId: conversationIdRef.current,
          })
          recallContext = conversationRecallMessage(recalled.snippets ?? [])
        } catch {
          // Best-effort: a failed recall must not block the answer.
        }
      }

      const memoryContext = memoryEnabled
        ? memoryContextMessage(memories)
        : ''
      const body: Record<string, unknown> = {
        messages: [
          ...(sysPrompt ? [{ role: 'system', content: sysPrompt }] : []),
          ...(recallContext ? [{ role: 'system', content: recallContext }] : []),
          ...(memoryContext ? [{ role: 'system', content: memoryContext }] : []),
          ...(searchContext ? [{ role: 'system', content: searchContext }] : []),
          ...newMessages.map(m => ({ role: m.role, content: toMessageContent(m.content, m.images) })),
        ],
        // Only the knobs switched on in the settings rail: temperature, top_p
        // and max_tokens, spelled as /v1/chat/completions parses them. An
        // untouched rail adds nothing at all, leaving provider defaults alone.
        ...samplingRequestParams(sampling),
      }
      if (selectedModel !== 'auto') body.model = selectedModel
      // Everything streams: fusion so you can watch the panel and the judge
      // arrive, every other model so the answer appears token by token instead
      // of after a silent minute.
      body.stream = true

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      const start = Date.now()
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      const latency = Date.now() - start
      const routedVia = res.headers.get('X-Routed-Via')
      const fallbackAttempts = res.headers.get('X-Fallback-Attempts')

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
        // A refused request still ends an exchange, and the question that
        // provoked it is worth keeping — save the error bubble along with it.
        const failed: ChatMessage[] = [...newMessages, {
          role: 'assistant',
          isError: true,
          content: err.error?.message ?? t('common.unknownError'),
        }]
        setMessages(failed)
        await persistConversation(failed)
        return
      }

      if (isFusion && res.body) {
        await streamFusion(res.body, newMessages, start)
        return
      }

      // The proxy answers a streamed request with SSE or not at all (every
      // pre-commit failure is a non-2xx JSON body, already handled above), but
      // fall back to the buffered path rather than trusting that: a proxy in
      // front of us, or a future non-streaming route, can still hand back JSON.
      if (!isFusion && res.body && (res.headers.get('Content-Type') ?? '').includes('text/event-stream')) {
        await streamChat(res.body, newMessages, start, routedVia, fallbackAttempts, webSearchMeta)
        return
      }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2)
      const via = data._routed_via ?? (routedVia ? {
        platform: routedVia.split('/')[0],
        model: routedVia.split('/').slice(1).join('/'),
      } : undefined)

      // Fusion responses carry a structured routing summary so we can show the
      // panel models that replied + the judge, rather than parsing the compact
      // X-Routed-Via string.
      const fusion = data._fusion as
        | { panel: { platform: string; model: string }[]; judge: { platform: string; model: string } | null }
        | undefined

      const answered: ChatMessage[] = [...newMessages, {
        role: 'assistant',
        content,
        meta: {
          platform: via?.platform,
          model: via?.model,
          latency,
          fallbackAttempts: fallbackAttempts ? parseInt(fallbackAttempts) : undefined,
          fusionPanel: fusion?.panel,
          fusionJudge: fusion?.judge,
          ...(webSearchMeta ? { webSearch: webSearchMeta } : {}),
        },
      }]
      setMessages(answered)
      await persistConversation(answered)
      void extractMemoriesFromExchange(answered)
    } catch (caught) {
      const err = caught instanceof Error ? caught : new Error(String(caught))
      // Clearing the chat (or leaving the page) aborts the stream on purpose —
      // that is not a failure to report, and the transcript it belonged to is
      // already gone.
      if (err.name === 'AbortError') {
        // Stopped before the first byte: there is no reply to keep, but the
        // question is.
        if (stoppedRef.current) await persistConversation(newMessages)
        return
      }
      const failed: ChatMessage[] = [...newMessages, {
        role: 'assistant',
        isError: true,
        content: err.message,
      }]
      setMessages(failed)
      await persistConversation(failed)
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  const handleSend = async () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || loading) return

    // Text-like files are inlined into the prompt; images ride along as data
    // URIs and become `image_url` parts in the request envelope.
    const userMsg: ChatMessage = {
      role: 'user',
      content: composeText(text, attachments),
      ...(pendingImages.length > 0 ? { images: pendingImages } : {}),
    }
    setInput('')
    setAttachments([])
    await runReply([...messages, userMsg], text)
  }

  // Replace the last reply (or error) with a fresh one for the same question.
  const regenerate = () => {
    if (loading) return
    const base = regenerationBase(messages)
    if (!base) return
    void runReply(base, lookupText(base[base.length - 1]))
  }

  // Edit a sent message and answer it again; everything after it is dropped.
  const submitEdit = (index: number, text: string) => {
    if (loading) return
    const edited = editedTranscript(messages, index, text)
    if (!edited) return
    void runReply(edited, lookupText(edited[edited.length - 1]))
  }

  // A starter fills the composer and leaves the cursor at the end of it, ready
  // for the part only the person can add. It never sends by itself.
  const pickStarter = (prompt: string) => {
    setInput(prompt)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }

  // Read a reply aloud, or stop reading it. One reply at a time: starting
  // another replaces the one in progress.
  const toggleSpeak = (index: number) => {
    if (speakingIndex === index) { stopSpeaking(); return }
    speakerRef.current ??= createSpeaker()
    setSpeakingIndex(index)
    speakerRef.current.speak(messages[index].content, locale, () => setSpeakingIndex(null))
  }

  // Thumbs on a reply: pressing the same one again takes it back. Saved with
  // the conversation like the rest of the transcript.
  const setFeedback = (index: number, value: 'up' | 'down') => {
    const next = messages.map((message, i) => {
      if (i !== index) return message
      const { feedback, ...rest } = message
      return feedback === value ? rest : { ...rest, feedback: value }
    })
    setMessages(next)
    void persistConversation(next)
  }

  // Download any saved conversation as a Markdown file.
  const handleExportConversation = async (id: number) => {
    try {
      const conversation = await getConversation(id)
      const markdown = conversationToMarkdown(conversation, {
        you: t('playground.exportYou'),
        assistant: t('playground.exportAssistant'),
      })
      downloadTextFile(exportFilename(conversation.title), markdown)
    } catch {
      toast.error(t('playgroundSessions.exportFailed'))
    }
  }

  const handleStop = () => {
    stoppedRef.current = true
    abortRef.current?.abort()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && loading) {
      e.preventDefault()
      handleStop()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // "Clear" no longer throws the chat away: it starts a NEW conversation and
  // leaves the old one in the sidebar. (resetConversationState stops an open
  // stream too, or its next frame would paste the half-finished answer back
  // into the empty transcript.)

  const activeModelLabel = selectedModel === 'auto'
    ? t('playground.autoModel')
    : selectedModel === 'fusion'
    ? t('playground.fusionModel')
    : selectedModel.startsWith('auto:')
    // A remembered chain whose name has since changed (or been deleted) has no
    // option left to read a label from; the raw id is still the truth.
    ? chainOptions.find(o => o.value === selectedModel)?.label ?? selectedModel
    : modelOptions.find(o => o.value === selectedModel)?.label ?? selectedModel

  return (
    // Conversations rail + chat (+ optional artifact panel). The page is a
    // flex child of the shell's full-bleed container, so it is exactly as tall
    // as the viewport (minus any desktop drag bar) and nothing here scrolls
    // except the panes that mean to.
    // Every lucide icon draws at 1.5 instead of the default 2: the page is
    // dense with small glyphs and the bold stroke read heavy.
    <div className="flex min-h-0 flex-1 overflow-hidden [&_svg]:stroke-[1.5]">
      <ConversationSidebar
        conversations={conversations}
        projects={projects}
        activeId={conversationId}
        open={sidebarOpen}
        onToggle={toggleSidebar}
        onNew={handleNewConversation}
        onSelect={handleSelectConversation}
        onRename={handleRenameConversation}
        onExport={handleExportConversation}
        onDelete={handleDeleteConversation}
        onCreateProject={handleCreateProject}
        onRenameProject={handleRenameProject}
        onDeleteProject={handleDeleteProject}
        onMoveConversation={handleMoveConversation}
        onOpenSettings={openSettings}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto p-6">
          {/* The chat sits in a centred column; the composer below shares its width. */}
          <div className="mx-auto h-full w-full max-w-3xl space-y-4">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center">
              <div className="w-full max-w-lg space-y-2">
                <p className="text-base font-medium">{t('playground.emptyTitle')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('playground.emptyDescription', { model: activeModelLabel })}
                </p>
                <StarterPrompts
                  items={[
                    { id: 'explain', icon: Lightbulb, label: t('playground.starterExplain'), prompt: t('playground.starterExplainPrompt') },
                    { id: 'write', icon: Mail, label: t('playground.starterWrite'), prompt: t('playground.starterWritePrompt') },
                    { id: 'summarize', icon: FileText, label: t('playground.starterSummarize'), prompt: t('playground.starterSummarizePrompt') },
                    { id: 'code', icon: Code, label: t('playground.starterCode'), prompt: t('playground.starterCodePrompt') },
                  ]}
                  onPick={pickStarter}
                />
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => {
                const fusionPanel = msg.meta?.fusionPanel
                const okPanel = fusionPanel?.filter(p => p.status !== 'failed') ?? []
                // Skip an empty assistant bubble while the fusion trace is still
                // streaming in (no final answer yet) — the trace shows below.
                // Reasoning that arrives before the first answer token counts:
                // that IS the bubble's content for the moment.
                const showBubble = msg.role === 'user' || msg.content.length > 0 || !!msg.reasoning
                const isEditing = editing?.index === i && msg.role === 'user'
                return (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {/* The user speaks in a bubble; the assistant answers as plain
                        text across the whole column — no box, no padding, no fill.
                        Errors keep their tinted box so they read as errors. */}
                    <div className={`group/row flex flex-col gap-1 ${msg.role === 'user' ? 'max-w-[80%] items-end' : 'w-full items-start'}`}>
                      {isEditing ? (
                        <MessageEditor
                          initial={editing.text}
                          onSubmit={text => submitEdit(i, text)}
                          onCancel={() => setEditing(null)}
                          labels={{ send: t('playground.editSend'), cancel: t('common.cancel') }}
                        />
                      ) : showBubble && (
                        <div
                          className={`group relative text-sm leading-relaxed ${
                            msg.role === 'user'
                              ? 'rounded-2xl bg-primary px-4 py-2.5 text-primary-foreground'
                              : msg.isError
                                ? 'rounded-2xl border border-destructive/25 bg-destructive/10 px-4 py-2.5 text-destructive'
                                : 'w-full'
                          }`}
                        >
                          {msg.images && msg.images.length > 0 && (
                            <div className="mb-2 flex flex-wrap gap-1.5">
                              {msg.images.map((src, n) => (
                                <img key={n} src={src} alt="" className="size-20 rounded-lg object-cover" />
                              ))}
                            </div>
                          )}
                          {msg.isError ? (
                            <div className="flex items-start gap-2">
                              <CircleAlert className="mt-0.5 size-4 shrink-0" />
                              <div className="min-w-0">
                                <p className="font-medium">{t('playground.errorTitle')}</p>
                                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                              </div>
                            </div>
                          ) : msg.role === 'assistant' ? (
                            <>
                              {(msg.reasoning || (msg.meta?.webSearch && msg.meta.webSearch.sources.length > 0)) && (
                                <ReplyTrace
                                  reasoning={msg.reasoning}
                                  search={msg.meta?.webSearch}
                                  answerStarted={msg.content.length > 0}
                                />
                              )}
                              <ArtifactHostContext.Provider value={artifactHost}>
                                <Markdown>{msg.content}</Markdown>
                              </ArtifactHostContext.Provider>
                            </>
                          ) : (
                            <div className="whitespace-pre-wrap">{msg.content}</div>
                          )}
                          {msg.meta && (
                            <div className="flex items-center gap-2 mt-2 flex-wrap text-[11px] opacity-70 tabular-nums">
                              {(fusionPanel || msg.meta.fusionStreaming) ? (
                                <>
                                  {okPanel.length > 0 && (
                                    <span>
                                      {t('playground.fusionPanel')}:{' '}
                                      <span className="font-mono">{okPanel.map(fusionRouteLabel).join(', ')}</span>
                                    </span>
                                  )}
                                  {msg.meta.fusionJudge && (
                                    <span>
                                      · {t('playground.fusionJudge')}:{' '}
                                      <span className="font-mono">{fusionRouteLabel(msg.meta.fusionJudge)}</span>
                                    </span>
                                  )}
                                  {msg.meta.latency != null && <span>· {msg.meta.latency} ms</span>}
                                </>
                              ) : (
                                <>
                                  {/* The maker's mark stands in for the host's name; the
                                      host is in the tooltip. Unknown makers get a neutral glyph. */}
                                  {(msg.meta.model || msg.meta.platform) && (
                                    <ModelMakerIcon modelId={msg.meta.model} platform={msg.meta.platform} className="size-3" />
                                  )}
                                  {msg.meta.model && <span className="font-mono">{msg.meta.model}</span>}
                                  {/* Which provider served it is known from the
                                      response headers straight away; the timing
                                      only means something once the last frame
                                      has landed. */}
                                  {msg.meta.latency != null && !msg.streaming && <span>· {msg.meta.latency} ms</span>}
                                  {msg.meta.fallbackAttempts != null && msg.meta.fallbackAttempts > 0 && (
                                    <span>· {msg.meta.fallbackAttempts} {msg.meta.fallbackAttempts > 1 ? t('playground.fallbacks') : t('playground.fallback')}</span>
                                  )}
                                </>
                              )}
                              {msg.role === 'assistant' && !msg.isError && msg.content && (
                                <CopyButton
                                  text={msg.content}
                                  label={t('playground.copyReply')}
                                  className="size-5 border-0 bg-transparent opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-60 hover:!opacity-100"
                                />
                              )}
                            </div>
                          )}
                          {!msg.meta && msg.role === 'assistant' && !msg.isError && msg.content && (
                            <CopyButton
                              text={msg.content}
                              label={t('playground.copyReply')}
                              className="mt-1 size-5 border-0 bg-transparent opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-60 hover:!opacity-100"
                            />
                          )}
                        </div>
                      )}
                      {msg.role === 'assistant' && fusionPanel && fusionPanel.length > 0 && (
                        <FusionTrace
                          panel={fusionPanel}
                          judge={msg.meta?.fusionJudge}
                          streaming={msg.meta?.fusionStreaming}
                          answerStarted={msg.content.length > 0}
                        />
                      )}
                      {!loading && !isEditing && msg.role === 'user' && (
                        <div className="flex gap-1">
                          <MessageActionButton
                            icon={Pencil}
                            label={t('playground.editMessage')}
                            onClick={() => setEditing({ index: i, text: msg.content })}
                          />
                        </div>
                      )}
                      {!loading && msg.role === 'assistant' && !msg.streaming && (
                        <div className="flex gap-1">
                          {!msg.isError && msg.content && (
                            <>
                              {SPEECH_OK && (
                                <MessageActionButton
                                  icon={speakingIndex === i ? Square : Volume2}
                                  label={t(speakingIndex === i ? 'playground.stopReading' : 'playground.readAloud')}
                                  active={speakingIndex === i}
                                  onClick={() => toggleSpeak(i)}
                                />
                              )}
                              <MessageActionButton
                                icon={ThumbsUp}
                                label={t('playground.feedbackGood')}
                                active={msg.feedback === 'up'}
                                onClick={() => setFeedback(i, 'up')}
                              />
                              <MessageActionButton
                                icon={ThumbsDown}
                                label={t('playground.feedbackBad')}
                                active={msg.feedback === 'down'}
                                onClick={() => setFeedback(i, 'down')}
                              />
                            </>
                          )}
                          {canRegenerate(messages, i) && (
                            <MessageActionButton
                              icon={RefreshCw}
                              label={msg.isError ? t('errors.tryAgain') : t('playground.regenerate')}
                              onClick={regenerate}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
              {/* Typing dots until the reply starts materialising — which is
                  the first fusion frame, the first token of a stream, or the
                  whole message on the buffered path. */}
              {loading && messages[messages.length - 1]?.role === 'user' && (
                <div className="flex justify-start">
                  <div className="py-2">
                    <div className="flex gap-1">
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
          </div>
        </div>

        <div
          className={`w-full px-2 pb-4 pt-1 transition-colors sm:mx-auto sm:max-w-3xl sm:px-6 ${dragging ? 'rounded-2xl bg-primary/5 ring-1 ring-inset ring-primary/40' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
          onDrop={e => {
            e.preventDefault()
            setDragging(false)
            addFiles([...e.dataTransfer.files])
          }}
        >
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map(a => (
                <div key={a.id} className="relative flex items-center gap-1.5 rounded-lg border bg-background py-1 pl-1.5 pr-6 text-xs">
                  {a.kind === 'image' && a.dataUrl
                    ? <img src={a.dataUrl} alt="" className="size-8 rounded object-cover" />
                    : <FileText className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="max-w-[140px] truncate">{a.name}</span>
                  <button
                    type="button"
                    aria-label={t('common.remove')}
                    title={t('common.remove')}
                    onClick={() => removeAttachment(a.id)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {modelBlindToImages && (
            <div className="mb-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{t('playground.visionWarning', { model: activeModelLabel })}</span>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT_ATTRIBUTE}
            className="hidden"
            onChange={e => {
              addFiles([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <LiquidComposer
            inputRef={inputRef}
            value={input}
            onChange={setInput}
            onKeyDown={handleKeyDown}
            onPaste={e => {
              // Screenshot straight from the clipboard; a normal text paste
              // carries no files and falls through untouched.
              const files = [...e.clipboardData.files]
              if (files.length === 0) return
              e.preventDefault()
              addFiles(files)
            }}
            placeholder={t('playground.inputPlaceholder')}
            hasContent={composerHasContent(input, attachments.length)}
            loading={loading}
            onSend={handleSend}
            onStop={handleStop}
            onAttach={() => fileInputRef.current?.click()}
            labels={{ add: t('playground.addMenu'), attach: t('playground.attach'), send: t('playground.send'), stop: t('playground.stop') }}
            dictation={{
              available: transcriptionAvailable,
              model: dictationModel,
              apiKey: keyData?.apiKey,
              onText: text => {
                setInput(prev => appendDictation(prev, text))
                inputRef.current?.focus()
              },
            }}
            webSearch={{
              enabled: webSearchOn,
              available: webSearchAvailable,
              label: t('search.playgroundToggle'),
              unavailableHint: t('search.playgroundNoKeys'),
              onToggle: updateWebSearch,
            }}
          />
        </div>
      </div>

      {artifact && (
        <ArtifactPanel
          artifact={artifact}
          open={artifactOpen}
          width={artifactWidth}
          onWidthChange={setArtifactWidth}
          onWidthCommit={commitArtifactWidth}
          onClose={closeArtifact}
        />
      )}
    </div>
  )
}
