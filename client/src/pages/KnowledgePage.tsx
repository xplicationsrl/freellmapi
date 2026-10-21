import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, RefreshCw, Trash2, Upload } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { prepareKnowledgeUpload } from '@/lib/knowledge-extract'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface Base {
  id: number
  name: string
  embeddingFamily: string | null
  dimensions: number | null
  documents: number
  ready: number
  failed: number
}

interface Doc {
  id: number
  name: string
  status: 'queued' | 'processing' | 'ready' | 'failed'
  error: string | null
  chunks: number
}

interface Passage {
  id: string
  documentId: number
  documentName: string
  ordinal: number
  page: number | null
  heading: string | null
  text: string
}

interface Families { default: string; families: string[] }

const STATUS_TONE: Record<Doc['status'], 'default' | 'secondary' | 'destructive'> = {
  ready: 'default', queued: 'secondary', processing: 'secondary', failed: 'destructive',
}

function BaseCard({ base, families, onChange }: { base: Base; families: Families | undefined; onChange: () => void }) {
  const qc = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(0)
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<{ document: Doc; chunks: { ordinal: number; text: string; page: number | null }[]; focus: number } | null>(null)

  const docs = useQuery<Doc[]>({
    queryKey: ['kb-docs', base.id],
    queryFn: () => apiFetch(`/api/knowledge/bases/${base.id}/documents`),
    // Indexing runs in the background: keep looking until it settles.
    refetchInterval: q => (q.state.data?.some(d => d.status === 'queued' || d.status === 'processing') ? 2000 : false),
  })
  const refreshDocs = () => {
    void qc.invalidateQueries({ queryKey: ['kb-docs', base.id] })
    onChange()
  }

  const upload = async (files: FileList | null) => {
    if (!files) return
    setUploadError(null)
    for (const file of Array.from(files)) {
      setUploading(n => n + 1)
      try {
        const body = await prepareKnowledgeUpload(file)
        await apiFetch(`/api/knowledge/bases/${base.id}/documents`, { method: 'POST', body: JSON.stringify(body) })
      } catch (err) {
        setUploadError(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`)
      } finally {
        setUploading(n => n - 1)
      }
    }
    refreshDocs()
  }

  const removeDoc = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/knowledge/documents/${id}`, { method: 'DELETE' }),
    onSuccess: refreshDocs,
  })
  const retryDoc = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/knowledge/documents/${id}/retry`, { method: 'POST' }),
    onSuccess: refreshDocs,
  })
  const removeBase = useMutation({
    mutationFn: () => apiFetch(`/api/knowledge/bases/${base.id}`, { method: 'DELETE' }),
    onSuccess: onChange,
  })
  const reindex = useMutation({
    mutationFn: (embeddingFamily?: string) =>
      apiFetch(`/api/knowledge/bases/${base.id}/reindex`, { method: 'POST', body: JSON.stringify(embeddingFamily ? { embeddingFamily } : {}) }),
    onSuccess: refreshDocs,
  })
  const search = useMutation({
    mutationFn: () => apiFetch<{ passages: Passage[]; evidence: string }>(
      `/api/knowledge/bases/${base.id}/search`, { method: 'POST', body: JSON.stringify({ query }) },
    ),
  })

  const openPreview = async (p: Passage) => {
    const out = await apiFetch<{ document: Doc; chunks: { ordinal: number; text: string; page: number | null }[]; focus: number }>(
      `/api/knowledge/documents/${p.documentId}/chunks/${p.ordinal}`,
    )
    setPreview(out)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {base.name}
          <span className="text-xs font-normal text-muted-foreground">
            {base.embeddingFamily ? `${base.embeddingFamily} · ${base.dimensions ?? '?'} dims` : 'model set on first upload'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" multiple accept=".txt,.md,.markdown,.pdf,.docx" className="hidden"
            onChange={e => { void upload(e.target.files); e.target.value = '' }} />
          <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploading > 0}>
            <Upload className="size-3.5" /> {uploading > 0 ? 'Reading…' : 'Add documents'}
          </Button>
          {families && families.families.length > 1 && (
            <select
              className="rounded-md border bg-background px-2 py-1 text-xs"
              value=""
              onChange={e => {
                if (e.target.value && window.confirm(`Reindex "${base.name}" with ${e.target.value}? Existing vectors are replaced.`)) {
                  reindex.mutate(e.target.value)
                }
              }}
            >
              <option value="">Switch embedding model…</option>
              {families.families.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          )}
          <Button size="sm" variant="outline" onClick={() => reindex.mutate(undefined)}>
            <RefreshCw className="size-3.5" /> Reindex
          </Button>
          <Button size="sm" variant="outline" onClick={() => { if (window.confirm(`Delete "${base.name}" and its documents?`)) removeBase.mutate() }}>
            <Trash2 className="size-3.5" /> Delete
          </Button>
        </div>
        {uploadError && <p className="text-destructive">{uploadError}</p>}

        {docs.data && docs.data.length === 0 && <p className="text-muted-foreground">No documents yet.</p>}
        <ul className="flex flex-col gap-1">
          {docs.data?.map(d => (
            <li key={d.id} className="flex flex-wrap items-center gap-2">
              <FileText className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              <Badge variant={STATUS_TONE[d.status]}>{d.status}{d.status === 'ready' ? ` · ${d.chunks} passages` : ''}</Badge>
              {d.status === 'failed' && (
                <>
                  <span className="max-w-64 truncate text-xs text-destructive" title={d.error ?? ''}>{d.error}</span>
                  <Button size="xs" variant="outline" onClick={() => retryDoc.mutate(d.id)}>Retry</Button>
                </>
              )}
              <Button size="xs" variant="ghost" aria-label={`Delete ${d.name}`} onClick={() => removeDoc.mutate(d.id)}>
                <Trash2 className="size-3" />
              </Button>
            </li>
          ))}
        </ul>

        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
            placeholder="Try a question against this base"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && query.trim()) search.mutate() }}
          />
          <Button size="sm" variant="outline" disabled={!query.trim() || search.isPending} onClick={() => search.mutate()}>
            Search
          </Button>
        </div>
        {search.error && <p className="text-destructive">{(search.error as Error).message}</p>}
        {search.data && (
          <div className="flex flex-col gap-2">
            {search.data.passages.length === 0 && (
              <p className="text-muted-foreground">Nothing relevant found. The chat will say so rather than guess.</p>
            )}
            {search.data.evidence === 'weak' && <p className="text-amber-600">Weak match.</p>}
            {search.data.passages.map(p => (
              <button key={p.id} type="button" className="rounded border p-2 text-left hover:bg-muted/40" onClick={() => void openPreview(p)}>
                <span className="font-mono text-xs">{p.id}</span>{' '}
                <span className="text-xs text-muted-foreground">{p.documentName}{p.page ? ` · p.${p.page}` : ''}{p.heading ? ` · ${p.heading}` : ''}</span>
                <p className="mt-1 line-clamp-3 text-xs">{p.text}</p>
              </button>
            ))}
          </div>
        )}
        {preview && (
          <div className="rounded border bg-muted/30 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium">{preview.document.name}</span>
              <Button size="xs" variant="ghost" onClick={() => setPreview(null)}>Close</Button>
            </div>
            {preview.chunks.map(c => (
              <p key={c.ordinal} className={`mb-2 whitespace-pre-wrap text-xs ${c.ordinal === preview.focus ? 'bg-amber-200/40 dark:bg-amber-500/20' : 'text-muted-foreground'}`}>
                {c.page ? `[p.${c.page}] ` : ''}{c.text}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function KnowledgePage() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const bases = useQuery<Base[]>({ queryKey: ['kb-bases'], queryFn: () => apiFetch('/api/knowledge/bases'), retry: false })
  const families = useQuery<Families>({ queryKey: ['kb-families'], queryFn: () => apiFetch('/api/knowledge/embedding-families'), retry: false })
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['kb-bases'] }) }
  const create = useMutation({
    mutationFn: () => apiFetch('/api/knowledge/bases', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: () => { setName(''); refresh() },
  })

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Knowledge"
        description="Upload documents and pick them in the Agent chat. Answers cite the passages they used."
      />
      {bases.error && (
        <p className="text-sm text-muted-foreground">Knowledge is off. Set FEATURE_KNOWLEDGE=1 on the server to turn it on.</p>
      )}
      {bases.data && (
        <>
          {bases.data.map(b => <BaseCard key={b.id} base={b} families={families.data} onChange={refresh} />)}
          <div className="flex gap-2">
            <input className="rounded-md border bg-background px-3 py-1.5 text-sm" placeholder="New knowledge base" value={name} onChange={e => setName(e.target.value)} />
            <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Create</Button>
          </div>
          {create.error && <p className="text-sm text-destructive">{(create.error as Error).message}</p>}
        </>
      )}
    </div>
  )
}
