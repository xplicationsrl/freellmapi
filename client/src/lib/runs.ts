// Client for server-side conversation runs (POST /api/runs and friends): the
// SSE reader, the small API wrappers, and a pure reducer that folds the event
// stream into the state the chat renders. Pure parts are unit-testable without
// a component or a live server.

import type { RunArtifact, RunCitation, RunEvent, ToolSource } from '@freellmapi/shared/conversation-events'
import { API_BASE, apiFetch, getToken } from './api'

export type { RunEvent } from '@freellmapi/shared/conversation-events'

export interface RunRequest {
  conversationId: number
  model: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string | unknown[] }[]
  systemPrompt?: string
  tools?: string[]
  knowledgeBases?: number[]
  attachments?: { name: string; mimeType: string; dataBase64: string }[]
  maxRounds?: number
}

export interface ToolView {
  callId: string
  name: string
  source: ToolSource
  arguments: unknown
  status: 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'denied' | 'cancelled'
  outcome?: 'unknown' | 'ok' | 'error' | 'uncertain'
  summary?: string
}

export interface RunView {
  runId: string | null
  text: string
  reasoning: string
  tools: ToolView[]
  artifacts: RunArtifact[]
  citations: RunCitation[]
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
  error?: string
}

export const EMPTY_RUN: RunView = {
  runId: null, text: '', reasoning: '', tools: [], artifacts: [], citations: [], status: 'idle',
}

/** Fold one event into the view. Never mutates its input. */
export function applyRunEvent(view: RunView, event: RunEvent): RunView {
  switch (event.type) {
    case 'run.started':
      return { ...EMPTY_RUN, runId: event.runId, status: 'running' }
    case 'message.delta':
      return { ...view, text: view.text + event.text }
    case 'message.reasoning':
      return { ...view, reasoning: view.reasoning + event.text }
    case 'tool.approval_required': {
      const tool: ToolView = {
        callId: event.callId, name: event.name, source: event.source,
        arguments: event.arguments, status: 'awaiting_approval',
      }
      return { ...view, tools: upsertTool(view.tools, tool) }
    }
    case 'tool.started': {
      const tool: ToolView = {
        callId: event.callId, name: event.name, source: event.source,
        arguments: event.arguments, status: 'running',
      }
      return { ...view, tools: upsertTool(view.tools, tool) }
    }
    case 'tool.completed': {
      const existing = view.tools.find(t => t.callId === event.callId)
      const tool: ToolView = {
        callId: event.callId,
        name: existing?.name ?? '',
        source: existing?.source ?? 'builtin',
        arguments: existing?.arguments,
        status: event.status,
        outcome: event.outcome,
        summary: event.summary,
      }
      return { ...view, tools: upsertTool(view.tools, tool) }
    }
    case 'artifact.created':
      return { ...view, artifacts: [...view.artifacts, event.artifact] }
    case 'citation.added':
      return view.citations.some(c => c.id === event.citation.id)
        ? view
        : { ...view, citations: [...view.citations, event.citation] }
    case 'run.failed':
      return { ...view, status: 'failed', error: event.message }
    case 'run.completed':
      return { ...view, status: event.status }
    default:
      return view
  }
}

function upsertTool(tools: ToolView[], next: ToolView): ToolView[] {
  const i = tools.findIndex(t => t.callId === next.callId)
  if (i < 0) return [...tools, next]
  const merged = { ...tools[i], ...next, name: next.name || tools[i].name }
  return tools.map((t, j) => (j === i ? merged : t))
}

/** Parse one SSE block into an event; null for comments, [DONE] or junk. */
export function parseRunFrame(frame: string): RunEvent | null {
  const data = frame
    .split(/\r\n|\r|\n/)
    .filter(l => l.startsWith('data:'))
    .map(l => l.slice(5).trim())
    .join('\n')
  if (!data || data === '[DONE]') return null
  try {
    const parsed = JSON.parse(data) as { type?: unknown }
    return typeof parsed.type === 'string' ? (parsed as RunEvent) : null
  } catch {
    return null
  }
}

/** Start a run and yield its events until the stream ends. */
export async function* streamRun(body: RunRequest, signal?: AbortSignal): AsyncGenerator<RunEvent> {
  const token = getToken()
  const res = await fetch(`${API_BASE}/api/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(err?.error?.message || `HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: !done })
    let sep: RegExpExecArray | null
    while ((sep = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, sep.index)
      buffer = buffer.slice(sep.index + sep[0].length)
      const event = parseRunFrame(frame)
      if (event) yield event
    }
    if (done) break
  }
  const tail = parseRunFrame(buffer)
  if (tail) yield tail
}

export interface RunToolInfo {
  name: string
  description: string
  source: ToolSource
  approval: 'never' | 'always'
}

export const runApi = {
  features: () => apiFetch<{ mcp_client: boolean; sandbox: boolean; knowledge: boolean; voice: boolean }>('/api/runs/features'),
  tools: () => apiFetch<RunToolInfo[]>('/api/runs/tools'),
  cancel: (runId: string) => apiFetch<{ ok: boolean }>(`/api/runs/${runId}/cancel`, { method: 'POST' }),
  approve: (runId: string, callId: string, approved: boolean) =>
    apiFetch<{ ok: boolean }>(`/api/runs/${runId}/tools/${encodeURIComponent(callId)}/approval`, {
      method: 'POST', body: JSON.stringify({ approved }),
    }),
  get: (runId: string) => apiFetch<{
    id: string
    status: string
    error: { code: string; message: string } | null
    toolCalls: { callId: string; name: string; source: ToolSource; status: ToolView['status'] | 'pending'; outcome: ToolView['outcome'] }[]
  }>(`/api/runs/${runId}`),
}

/** Authenticated download of an artifact (the route needs the session header). */
export async function downloadArtifact(artifact: RunArtifact): Promise<void> {
  const token = getToken()
  const res = await fetch(`${API_BASE}/api/runs/artifacts/${artifact.id}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = artifact.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Blob URL for an inline image preview. Caller revokes it. */
export async function artifactObjectUrl(artifactId: string): Promise<string> {
  const token = getToken()
  const res = await fetch(`${API_BASE}/api/runs/artifacts/${artifactId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return URL.createObjectURL(await res.blob())
}
