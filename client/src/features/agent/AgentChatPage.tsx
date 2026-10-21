import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Mic, MicOff, Paperclip, Send, Square, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import {
  applyRunEvent, EMPTY_RUN, runApi, streamRun,
  type RunView,
} from '@/lib/runs'
import { PageHeader } from '@/components/page-header'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { ArtifactList, CitationList, ToolActivity } from './tool-activity'
import { useVoiceMode, type VoiceSendHooks } from './use-voice'

// A chat that runs on the server: the model can call tools (MCP servers, the
// code sandbox, document search) in a loop with approvals, and the same
// conversation can be spoken. It shares storage with the Playground
// (/api/conversations) but is its own page so the Playground stays small.

interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
  runId?: string
  view?: RunView
}

interface KnowledgeBase { id: number; name: string; ready: number; documents: number }

const MAX_ATTACH_BYTES = 5 * 1024 * 1024

const SAVED_KEY = 'agent.conversationId'

function readSavedConversation(): number | null {
  try {
    const n = Number(localStorage.getItem(SAVED_KEY))
    return Number.isInteger(n) && n > 0 ? n : null
  } catch { return null }
}
function saveConversation(id: number): void {
  try { localStorage.setItem(SAVED_KEY, String(id)) } catch { /* private mode */ }
}
function clearSavedConversation(): void {
  try { localStorage.removeItem(SAVED_KEY) } catch { /* private mode */ }
}

function toBase64(buf: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export default function AgentChatPage() {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [enabledTools, setEnabledTools] = useState<Set<string> | null>(null)
  const [bases, setBases] = useState<Set<number>>(new Set())
  const [files, setFiles] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)

  const busyRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const runIdRef = useRef<string | null>(null)
  const messagesRef = useRef<AgentMessage[]>([])
  const convoRef = useRef<number | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { convoRef.current = conversationId }, [conversationId])
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [messages])

  // Reload: pick the conversation back up and rebuild tool activity from the
  // stored runs.
  useEffect(() => {
    let live = true
    const saved = readSavedConversation()
    if (saved === null) return
    void (async () => {
      try {
        const convo = await apiFetch<{ id: number; messages: { role: 'user' | 'assistant'; content: string; meta?: { runId?: string } }[] }>(
          `/api/conversations/${saved}`,
        )
        const restored: AgentMessage[] = await Promise.all(convo.messages.map(async m => {
          const runId = m.meta?.runId
          if (m.role !== 'assistant' || !runId) return { role: m.role, content: m.content }
          try {
            const run = await runApi.get(runId)
            const view: RunView = {
              ...EMPTY_RUN,
              runId,
              text: m.content,
              status: run.status === 'failed' ? 'failed' : run.status === 'cancelled' ? 'cancelled' : 'completed',
              error: run.error?.message,
              tools: run.toolCalls.map(t => ({
                callId: t.callId, name: t.name, source: t.source, arguments: undefined,
                status: t.status === 'pending' ? 'running' : t.status, outcome: t.outcome,
              })),
            }
            return { role: m.role, content: m.content, runId, view }
          } catch {
            return { role: m.role, content: m.content, runId }
          }
        }))
        if (!live) return
        convoRef.current = convo.id
        setConversationId(convo.id)
        setMessages(restored)
      } catch {
        clearSavedConversation()
      }
    })()
    return () => { live = false }
  }, [])

  const { data: features } = useQuery({ queryKey: ['run-features'], queryFn: runApi.features })
  const { data: tools = [] } = useQuery({ queryKey: ['run-tools', features], queryFn: runApi.tools })
  const { data: knowledge = [] } = useQuery<KnowledgeBase[]>({
    queryKey: ['kb-bases'],
    queryFn: () => apiFetch('/api/knowledge/bases'),
    enabled: features?.knowledge === true,
  })
  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  // Default: every tool except the built-in test tools.
  const active = useMemo(
    () => enabledTools ?? new Set(tools.filter(t => t.source !== 'builtin').map(t => t.name)),
    [enabledTools, tools],
  )

  const persist = useCallback(async (next: AgentMessage[]) => {
    const body = {
      messages: next.filter(m => m.content.trim()).map(m => ({
        role: m.role,
        content: m.content,
        ...(m.runId ? { meta: { runId: m.runId } } : {}),
      })),
    }
    const id = convoRef.current
    if (id === null) {
      const title = next.find(m => m.role === 'user')?.content.slice(0, 60) || 'Agent chat'
      const created = await apiFetch<{ id: number }>('/api/conversations', {
        method: 'POST', body: JSON.stringify({ title, ...body }),
      })
      convoRef.current = created.id
      setConversationId(created.id)
      saveConversation(created.id)
    } else {
      await apiFetch(`/api/conversations/${id}`, { method: 'PUT', body: JSON.stringify(body) })
    }
  }, [])

  const patchLast = useCallback((fn: (m: AgentMessage) => AgentMessage) => {
    setMessages(prev => prev.length ? [...prev.slice(0, -1), fn(prev[prev.length - 1])] : prev)
  }, [])

  const send = useCallback(async (text: string, hooks?: VoiceSendHooks) => {
    const trimmed = text.trim()
    // A typed message waits for the current run; a spoken one replaces it
    // (barge-in already cancelled it).
    if (!trimmed || (busyRef.current && !hooks)) return
    busyRef.current = true
    setError(null)
    setBusy(true)
    const userMsg: AgentMessage = { role: 'user', content: trimmed }
    const history = [...messagesRef.current, userMsg]
    const attachFiles = files
    setMessages([...history, { role: 'assistant', content: '', view: { ...EMPTY_RUN, status: 'running' } }])
    setInput('')
    setFiles([])

    const controller = new AbortController()
    abortRef.current = controller
    const signal = hooks ? AbortSignal.any([controller.signal, hooks.signal]) : controller.signal
    let view: RunView = { ...EMPTY_RUN, status: 'running' }

    try {
      // A run needs a stored conversation to hang off.
      if (convoRef.current === null) await persist(history)
      const attachments = await Promise.all(attachFiles.map(async f => ({
        name: f.name, mimeType: f.type || 'application/octet-stream', dataBase64: toBase64(await f.arrayBuffer()),
      })))
      for await (const event of streamRun({
        conversationId: convoRef.current!,
        model: 'auto',
        messages: history.map(m => ({ role: m.role, content: m.content })),
        tools: [...active],
        knowledgeBases: [...bases],
        attachments,
      }, signal)) {
        view = applyRunEvent(view, event)
        if (event.type === 'run.started') runIdRef.current = event.runId
        if (event.type === 'message.delta') hooks?.onDelta(event.text)
        const snapshot = view
        patchLast(m => ({ ...m, content: snapshot.text, runId: snapshot.runId ?? undefined, view: snapshot }))
      }
      hooks?.onGenerated()
      const final = [...history, { role: 'assistant' as const, content: view.text, runId: view.runId ?? undefined }]
      await persist(final)
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err.message : 'The run failed')
    } finally {
      // Only the newest run owns the shared refs.
      if (abortRef.current === controller) {
        busyRef.current = false
        setBusy(false)
        runIdRef.current = null
        abortRef.current = null
      }
    }
  }, [active, bases, files, patchLast, persist])

  const stop = useCallback(() => {
    const id = runIdRef.current
    if (id) void runApi.cancel(id).catch(() => undefined)
    abortRef.current?.abort()
  }, [])

  const approve = useCallback((callId: string, approved: boolean) => {
    const id = runIdRef.current
    if (id) void runApi.approve(id, callId, approved).catch(err => setError(err.message))
  }, [])

  const voice = useVoiceMode({
    apiKey: keyData?.apiKey,
    transcriptionModel: 'auto',
    speechModel: 'auto',
    voice: 'alloy',
    send,
    cancelRun: stop,
    // Keep only what the user heard, so the stored history is not misleading.
    onInterrupted: delivered => {
      patchLast(m => m.role === 'assistant' ? { ...m, content: delivered ? `${delivered} …` : '(interrupted)' } : m)
      void persist(messagesRef.current.map((m, i, all) =>
        i === all.length - 1 && m.role === 'assistant' ? { ...m, content: delivered || '(interrupted)' } : m,
      )).catch(() => undefined)
    },
  })

  const toggleTool = (name: string) => {
    const next = new Set(active)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setEnabledTools(next)
  }
  const toggleBase = (id: number) => {
    const next = new Set(bases)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setBases(next)
  }

  const onPickFiles = (list: FileList | null) => {
    if (!list) return
    const picked = [...files, ...list].slice(0, 5)
    if (picked.reduce((n, f) => n + f.size, 0) > MAX_ATTACH_BYTES) {
      setError('Attachments are limited to 5 MB in total')
      return
    }
    setFiles(picked)
  }

  const voiceAvailable = features?.voice === true

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Agent"
        description="Chat with tools: connected MCP servers, a Python sandbox and your documents."
        actions={(
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                clearSavedConversation()
                convoRef.current = null
                setConversationId(null)
                setMessages([])
                setError(null)
              }}
            >
              New chat
            </Button>
            {voiceAvailable && (
          <Button
            variant={voice.active ? 'default' : 'outline'}
            onClick={() => (voice.active ? voice.stop() : void voice.start())}
          >
            {voice.active ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            {voice.active ? 'End voice' : 'Voice mode'}
          </Button>
            )}
          </div>
        )}
      />

      <div className="flex flex-wrap gap-x-6 gap-y-2 pb-3 text-sm">
        {tools.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Tools</span>
            {tools.map(t => (
              <label key={t.name} className="flex items-center gap-1" title={t.description}>
                <input type="checkbox" checked={active.has(t.name)} onChange={() => toggleTool(t.name)} />
                <span className="font-mono text-xs">{t.name}</span>
              </label>
            ))}
          </div>
        )}
        {knowledge.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Documents</span>
            {knowledge.map(b => (
              <label key={b.id} className="flex items-center gap-1">
                <input type="checkbox" checked={bases.has(b.id)} onChange={() => toggleBase(b.id)} />
                <span>{b.name}</span>
                <span className="text-xs text-muted-foreground">({b.ready}/{b.documents} ready)</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {voice.active && (
        <div className="mb-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <div className="flex items-center gap-3">
            <span className="font-medium capitalize">{voice.state}</span>
            <div className="h-1.5 w-24 overflow-hidden rounded bg-muted">
              <div className="h-full bg-primary" style={{ width: `${Math.min(100, voice.level * 600)}%` }} />
            </div>
            {voice.transcript && <span className="truncate text-muted-foreground">“{voice.transcript}”</span>}
          </div>
          {Object.keys(voice.metrics).length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              transcription {voice.metrics.transcribeMs ?? '–'} ms · first token {voice.metrics.firstTokenMs ?? '–'} ms
              · speech generation {voice.metrics.speechGenerationMs ?? '–'} ms · playback start {voice.metrics.playbackStartMs ?? '–'} ms
            </p>
          )}
          {voice.error && (
            <p className="mt-1 text-xs text-destructive">
              {voice.error} <button className="underline" onClick={voice.recover}>Continue</button>
            </p>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border p-4">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Ask something. Enabled tools run on the server and ask before doing anything that needs approval.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`mb-4 ${m.role === 'user' ? 'text-right' : ''}`}>
            <div className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-left ${m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted/40'}`}>
              {m.role === 'assistant' && m.view && (
                <ToolActivity tools={m.view.tools} onApprove={approve} />
              )}
              {m.content
                ? (m.role === 'assistant' ? <Markdown>{m.content}</Markdown> : <p className="whitespace-pre-wrap text-sm">{m.content}</p>)
                : m.view?.status === 'running' && <span className="text-sm text-muted-foreground">Working…</span>}
              {m.view && <ArtifactList artifacts={m.view.artifacts} />}
              {m.view && <CitationList citations={m.view.citations} />}
              {m.view?.status === 'failed' && <p className="mt-1 text-sm text-destructive">{m.view.error}</p>}
              {m.view?.status === 'cancelled' && <p className="mt-1 text-xs text-muted-foreground">Stopped.</p>}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <p className="pt-2 text-sm text-destructive">{error}</p>}

      <form
        className="flex items-end gap-2 pt-3"
        onSubmit={e => { e.preventDefault(); void send(input) }}
      >
        <input ref={fileInput} type="file" multiple className="hidden" onChange={e => { onPickFiles(e.target.files); e.target.value = '' }} />
        <Button type="button" variant="outline" size="icon" onClick={() => fileInput.current?.click()} title="Attach files for the sandbox">
          <Paperclip className="size-4" />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {files.map(f => (
                <span key={f.name} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                  {f.name}
                  <button type="button" onClick={() => setFiles(files.filter(x => x !== f))} aria-label={`Remove ${f.name}`}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            className="min-h-10 w-full resize-none rounded-md border bg-background px-3 py-2 text-sm"
            rows={2}
            value={input}
            placeholder="Message"
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input) }
            }}
          />
        </div>
        {busy
          ? <Button type="button" variant="outline" size="icon" onClick={stop} title="Stop"><Square className="size-4" /></Button>
          : <Button type="submit" size="icon" disabled={!input.trim()} title="Send"><Send className="size-4" /></Button>}
      </form>
    </div>
  )
}
