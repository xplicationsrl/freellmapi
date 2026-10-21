import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plug, RefreshCw, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type Policy = 'allow' | 'ask' | 'deny'

interface McpServer {
  id: number
  name: string
  transport: 'http' | 'stdio'
  url: string | null
  command: string | null
  args: string[]
  headerNames: string[]
  envNames: string[]
  enabled: boolean
  allowPrivate: boolean
  defaultPolicy: Policy
  toolPolicy: Record<string, Policy>
  connected: boolean
  lastError: string | null
}

interface ServerList { stdioAllowed: boolean; servers: McpServer[] }
interface ServerTool { name: string; description: string; readOnly: boolean }
interface CallRow {
  call_id: string
  tool_name: string
  status: string
  outcome: string
  error_message: string | null
  started_at_ms: number | null
}

/** "Name: value" per line -> object. */
function parsePairs(text: string, separator: ':' | '='): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(separator)
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    if (key) out[key] = line.slice(i + 1).trim()
  }
  return out
}

function AddServerForm({ stdioAllowed, onDone }: { stdioAllowed: boolean; onDone: () => void }) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'http' | 'stdio'>('http')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [secrets, setSecrets] = useState('')
  const [allowPrivate, setAllowPrivate] = useState(false)
  const [policy, setPolicy] = useState<Policy>('ask')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => apiFetch('/api/mcp-servers', {
      method: 'POST',
      body: JSON.stringify({
        name,
        transport,
        ...(transport === 'http'
          ? { url, headers: parsePairs(secrets, ':'), allowPrivate }
          : { command, args: args.split('\n').map(a => a.trim()).filter(Boolean), env: parsePairs(secrets, '=') }),
        defaultPolicy: policy,
      }),
    }),
    onSuccess: () => { setError(null); onDone() },
    onError: (e: Error) => setError(e.message),
  })

  const field = 'w-full rounded-md border bg-background px-3 py-1.5 text-sm'
  return (
    <Card>
      <CardHeader><CardTitle>Add a server</CardTitle></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <input className={field} placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
        <select className={field} value={transport} onChange={e => setTransport(e.target.value as 'http' | 'stdio')}>
          <option value="http">Remote (Streamable HTTP)</option>
          <option value="stdio" disabled={!stdioAllowed}>
            Local process (stdio){stdioAllowed ? '' : ' - turn on in Settings > Agent'}
          </option>
        </select>
        {transport === 'http' ? (
          <input className={`${field} sm:col-span-2`} placeholder="https://example.com/mcp" value={url} onChange={e => setUrl(e.target.value)} />
        ) : (
          <>
            <input className={field} placeholder="Command, e.g. npx" value={command} onChange={e => setCommand(e.target.value)} />
            <textarea className={field} rows={3} placeholder={'Arguments, one per line'} value={args} onChange={e => setArgs(e.target.value)} />
          </>
        )}
        <textarea
          className={`${field} sm:col-span-2`}
          rows={3}
          placeholder={transport === 'http' ? 'Headers, one per line:\nAuthorization: Bearer …' : 'Environment, one per line:\nTOKEN=…'}
          value={secrets}
          onChange={e => setSecrets(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          New tools:
          <select className="rounded-md border bg-background px-2 py-1" value={policy} onChange={e => setPolicy(e.target.value as Policy)}>
            <option value="ask">Ask before each call</option>
            <option value="allow">Allow</option>
            <option value="deny">Hide</option>
          </select>
        </label>
        {transport === 'http' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowPrivate} onChange={e => setAllowPrivate(e.target.checked)} />
            Allow a local or private network address
          </label>
        )}
        {transport === 'stdio' && (
          <p className="text-xs text-amber-600 sm:col-span-2">
            Adding a local server lets this install run that program on the host.
          </p>
        )}
        {error && <p className="text-sm text-destructive sm:col-span-2">{error}</p>}
        <div className="sm:col-span-2">
          <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Connecting…' : 'Add and connect'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function EditServerForm({ server, onSave, onCancel, saving, error }: {
  server: McpServer
  onSave: (body: Record<string, unknown>) => void
  onCancel: () => void
  saving: boolean
  error: string | null
}) {
  const [name, setName] = useState(server.name)
  const [url, setUrl] = useState(server.url ?? '')
  const [command, setCommand] = useState(server.command ?? '')
  const [args, setArgs] = useState(server.args.join('\n'))
  const [secrets, setSecrets] = useState('')
  const [allowPrivate, setAllowPrivate] = useState(server.allowPrivate)
  const [policy, setPolicy] = useState<Policy>(server.defaultPolicy)
  const field = 'w-full rounded-md border bg-background px-3 py-1.5 text-sm'
  const http = server.transport === 'http'

  const submit = () => {
    const body: Record<string, unknown> = { name, defaultPolicy: policy }
    if (http) {
      body.url = url
      body.allowPrivate = allowPrivate
      if (secrets.trim()) body.headers = parsePairs(secrets, ':')
    } else {
      body.command = command
      body.args = args.split('\n').map(a => a.trim()).filter(Boolean)
      if (secrets.trim()) body.env = parsePairs(secrets, '=')
    }
    onSave(body)
  }

  return (
    <div className="grid gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
      <input className={field} value={name} onChange={e => setName(e.target.value)} aria-label="Name" />
      {http ? (
        <input className={field} value={url} onChange={e => setUrl(e.target.value)} aria-label="URL" />
      ) : (
        <>
          <input className={field} value={command} onChange={e => setCommand(e.target.value)} aria-label="Command" />
          <textarea className={`${field} sm:col-span-2`} rows={3} value={args} onChange={e => setArgs(e.target.value)} aria-label="Arguments, one per line" />
        </>
      )}
      <textarea
        className={`${field} sm:col-span-2`}
        rows={3}
        placeholder={`Replace stored ${http ? 'headers' : 'environment'} (one per line, ${http ? 'Name: value' : 'NAME=value'}). Leave empty to keep what is stored.`}
        value={secrets}
        onChange={e => setSecrets(e.target.value)}
      />
      <label className="flex items-center gap-2 text-sm">
        New tools:
        <select className="rounded-md border bg-background px-2 py-1" value={policy} onChange={e => setPolicy(e.target.value as Policy)}>
          <option value="ask">Ask before each call</option>
          <option value="allow">Allow</option>
          <option value="deny">Hide</option>
        </select>
      </label>
      {http && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allowPrivate} onChange={e => setAllowPrivate(e.target.checked)} />
          Allow a local or private network address
        </label>
      )}
      {error && <p className="text-sm text-destructive sm:col-span-2">{error}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <Button size="sm" disabled={!name.trim() || saving} onClick={submit}>{saving ? 'Saving…' : 'Save and reconnect'}</Button>
        <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

function ServerCard({ server, onChange }: { server: McpServer; onChange: () => void }) {
  const qc = useQueryClient()
  const tools = useQuery<{ connected: boolean; tools: ServerTool[] }>({
    queryKey: ['mcp-tools', server.id, server.connected],
    queryFn: () => apiFetch(`/api/mcp-servers/${server.id}/tools`),
  })
  const calls = useQuery<CallRow[]>({
    queryKey: ['mcp-calls', server.id],
    queryFn: () => apiFetch(`/api/mcp-servers/${server.id}/calls`),
  })
  const [editing, setEditing] = useState(false)
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/mcp-servers/${server.id}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { setEditing(false); onChange(); void qc.invalidateQueries({ queryKey: ['mcp-tools', server.id] }) },
  })
  const test = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; tools: number; error: string | null }>(`/api/mcp-servers/${server.id}/test`, { method: 'POST' }),
    onSuccess: onChange,
  })
  const remove = useMutation({
    mutationFn: () => apiFetch(`/api/mcp-servers/${server.id}`, { method: 'DELETE' }),
    onSuccess: onChange,
  })

  const setToolPolicy = (tool: string, policy: Policy) =>
    update.mutate({ toolPolicy: { ...server.toolPolicy, [tool]: policy } })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Plug className="size-4" />
          {server.name}
          <Badge variant={server.connected ? 'default' : 'secondary'}>
            {!server.enabled ? 'Disabled' : server.connected ? 'Connected' : 'Disconnected'}
          </Badge>
          <span className="text-xs font-normal text-muted-foreground">
            {server.transport === 'http' ? server.url : `${server.command} ${server.args.join(' ')}`}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {server.lastError && <p className="text-destructive">{server.lastError}</p>}
        {test.data && !test.data.ok && <p className="text-destructive">{test.data.error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
            <RefreshCw className="size-3.5" /> Test connection
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(e => !e)}>Edit</Button>
          <Button size="sm" variant="outline" onClick={() => update.mutate({ enabled: !server.enabled })}>
            {server.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { if (window.confirm(`Remove ${server.name}?`)) remove.mutate() }}
          >
            <Trash2 className="size-3.5" /> Remove
          </Button>
        </div>
        {editing && (
          <EditServerForm
            server={server}
            saving={update.isPending}
            error={update.error ? (update.error as Error).message : null}
            onCancel={() => setEditing(false)}
            onSave={body => update.mutate(body)}
          />
        )}
        {(server.headerNames.length > 0 || server.envNames.length > 0) && (
          <p className="text-xs text-muted-foreground">
            Stored secrets: {[...server.headerNames, ...server.envNames].join(', ')}
          </p>
        )}

        {tools.data && tools.data.tools.length > 0 && (
          <div>
            <p className="mb-1 font-medium">Tools</p>
            <div className="flex flex-col gap-1">
              {tools.data.tools.map(t => (
                <div key={t.name} className="flex items-center gap-2" title={t.description}>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{t.name}{t.readOnly ? ' (read-only)' : ''}</span>
                  <select
                    className="rounded-md border bg-background px-2 py-0.5 text-xs"
                    value={server.toolPolicy[t.name] ?? server.defaultPolicy}
                    onChange={e => setToolPolicy(t.name, e.target.value as Policy)}
                  >
                    <option value="allow">Allow</option>
                    <option value="ask">Ask</option>
                    <option value="deny">Hide</option>
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        {calls.data && calls.data.length > 0 && (
          <div>
            <p className="mb-1 font-medium">Recent calls</p>
            <ul className="flex flex-col gap-0.5 text-xs">
              {calls.data.slice(0, 8).map(c => (
                <li key={c.call_id} className="flex gap-2">
                  <span className="font-mono">{c.tool_name.replace(/^m\d+__/, '')}</span>
                  <span className="text-muted-foreground">{c.status}{c.outcome === 'uncertain' ? ' (uncertain)' : ''}</span>
                  {c.error_message && <span className="truncate text-destructive">{c.error_message}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function IntegrationsPage() {
  const qc = useQueryClient()
  const { data, error, isLoading } = useQuery<ServerList>({
    queryKey: ['mcp-servers'],
    queryFn: () => apiFetch('/api/mcp-servers'),
    retry: false,
  })
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['mcp-servers'] }) }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Integrations"
        description="Connect MCP servers so the Agent chat can use their tools. Calls need your approval unless you allow them."
      />
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p className="text-sm text-muted-foreground">
          Could not load integrations. Check that the server is up to date.
        </p>
      )}
      {data && (
        <>
          {data.servers.map(s => <ServerCard key={s.id} server={s} onChange={refresh} />)}
          <AddServerForm stdioAllowed={data.stdioAllowed} onDone={refresh} />
        </>
      )}
    </div>
  )
}
