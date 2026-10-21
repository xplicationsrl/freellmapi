import { useEffect, useState } from 'react'
import { Check, Download, FileText, Loader2, ShieldQuestion, X } from 'lucide-react'
import type { RunArtifact, RunCitation } from '@freellmapi/shared/conversation-events'
import { artifactObjectUrl, downloadArtifact, type ToolView } from '@/lib/runs'
import { Button } from '@/components/ui/button'

const STATUS_LABEL: Record<ToolView['status'], string> = {
  awaiting_approval: 'Waiting for your approval',
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  denied: 'Denied',
  cancelled: 'Cancelled',
}

function argsPreview(args: unknown): string {
  try {
    const text = JSON.stringify(args, null, 2)
    return text.length > 1200 ? `${text.slice(0, 1200)}…` : text
  } catch {
    return ''
  }
}

export function ToolActivity({ tools, onApprove }: {
  tools: ToolView[]
  onApprove: (callId: string, approved: boolean) => void
}) {
  if (tools.length === 0) return null
  return (
    <div className="my-2 flex flex-col gap-2">
      {tools.map(tool => (
        <details
          key={tool.callId}
          open={tool.status === 'awaiting_approval'}
          className="rounded-md border bg-muted/30 px-3 py-2 text-sm"
        >
          <summary className="flex cursor-pointer items-center gap-2">
            {tool.status === 'running' && <Loader2 className="size-3.5 animate-spin" />}
            {tool.status === 'completed' && <Check className="size-3.5 text-green-600" />}
            {(tool.status === 'failed' || tool.status === 'denied' || tool.status === 'cancelled') && (
              <X className="size-3.5 text-destructive" />
            )}
            {tool.status === 'awaiting_approval' && <ShieldQuestion className="size-3.5 text-amber-600" />}
            <span className="font-mono text-xs">{tool.name}</span>
            <span className="text-muted-foreground">{STATUS_LABEL[tool.status]}</span>
            {tool.outcome === 'uncertain' && (
              <span className="text-amber-600">outcome uncertain: not retried</span>
            )}
          </summary>
          {tool.arguments !== undefined && (
            <pre className="mt-2 max-h-56 overflow-auto rounded bg-background p-2 text-xs">{argsPreview(tool.arguments)}</pre>
          )}
          {tool.summary && <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{tool.summary}</p>}
          {tool.status === 'awaiting_approval' && (
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => onApprove(tool.callId, true)}>Approve</Button>
              <Button size="sm" variant="outline" onClick={() => onApprove(tool.callId, false)}>Deny</Button>
            </div>
          )}
        </details>
      ))}
    </div>
  )
}

function ArtifactImage({ artifact }: { artifact: RunArtifact }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let revoked: string | null = null
    let cancelled = false
    artifactObjectUrl(artifact.id).then(u => {
      if (cancelled) URL.revokeObjectURL(u)
      else { revoked = u; setUrl(u) }
    }).catch(() => undefined)
    return () => { cancelled = true; if (revoked) URL.revokeObjectURL(revoked) }
  }, [artifact.id])
  if (!url) return <div className="h-32 w-48 animate-pulse rounded bg-muted" />
  return <img src={url} alt={artifact.name} className="max-h-72 rounded border" />
}

export function ArtifactList({ artifacts }: { artifacts: RunArtifact[] }) {
  if (artifacts.length === 0) return null
  return (
    <div className="my-2 flex flex-col gap-2">
      {artifacts.filter(a => a.mimeType.startsWith('image/') && a.mimeType !== 'image/svg+xml').map(a => (
        <ArtifactImage key={a.id} artifact={a} />
      ))}
      <div className="flex flex-wrap gap-2">
        {artifacts.map(a => (
          <Button key={a.id} size="sm" variant="outline" onClick={() => void downloadArtifact(a)}>
            <Download className="mr-1 size-3.5" />
            {a.name}
          </Button>
        ))}
      </div>
    </div>
  )
}

export function CitationList({ citations, onOpen }: { citations: RunCitation[]; onOpen?: (id: string) => void }) {
  if (citations.length === 0) return null
  return (
    <div className="my-2 flex flex-wrap gap-2">
      {citations.map(c => (
        <button
          type="button"
          key={c.id}
          onClick={() => onOpen?.(c.id)}
          title="Open the source passage"
          className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:bg-muted"
        >
          <FileText className="size-3" />
          <span className="font-mono">{c.id}</span>
          <span className="text-muted-foreground">{c.title}{c.location ? ` · ${c.location}` : ''}</span>
        </button>
      ))}
    </div>
  )
}
