import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Switch } from '@/components/ui/switch'

// Settings > Agent: the operator options for the Agent chat that used to need
// environment variables. English only for now (no locale entries).

interface AgentSettings {
  sandboxUrl: string
  hasSandboxToken: boolean
  allowStdio: boolean
  sandboxAutoApprove: boolean
}

const input = 'w-full rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50'

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border/60 py-4 last:border-b-0 last:pb-0">
      <div className="mb-2">
        <span className="text-sm font-medium">{label}</span>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

export function AgentSettingsSection() {
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let live = true
    apiFetch<AgentSettings>('/api/agentic-settings')
      .then(s => { if (live) { setSettings(s); setUrl(s.sandboxUrl) } })
      .catch(err => { if (live) setMessage({ ok: false, text: err.message }) })
    return () => { live = false }
  }, [])

  const save = async (patch: Partial<{ sandboxUrl: string; sandboxToken: string; allowStdio: boolean; sandboxAutoApprove: boolean }>) => {
    setBusy('save')
    setMessage(null)
    try {
      const next = await apiFetch<AgentSettings>('/api/agentic-settings', { method: 'PUT', body: JSON.stringify(patch) })
      setSettings(next)
      setMessage({ ok: true, text: 'Saved' })
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Could not save' })
    } finally {
      setBusy(null)
    }
  }

  const generateToken = () => {
    const bytes = new Uint8Array(24)
    crypto.getRandomValues(bytes)
    setToken(Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''))
  }

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setMessage({ ok: true, text: 'Copied' }),
      () => setMessage({ ok: false, text: 'Could not copy' }),
    )
  }

  const saveSandbox = async () => {
    await save({ sandboxUrl: url, ...(token ? { sandboxToken: token } : {}) })
    setToken('')
  }

  const test = async () => {
    setBusy('test')
    setMessage(null)
    try {
      const out = await apiFetch<{ ok: boolean; image?: string; error?: string }>(
        '/api/agentic-settings/sandbox/test', { method: 'POST' },
      )
      setMessage(out.ok
        ? { ok: true, text: `Worker is up (image ${out.image ?? 'unknown'})` }
        : { ok: false, text: out.error ?? 'The worker did not answer' })
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setBusy(null)
    }
  }

  if (!settings) {
    return message
      ? <p className="text-sm text-destructive">{message.text}</p>
      : <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading</div>
  }

  return (
    <>
      <div className="mb-5 space-y-1.5">
        <h2 className="font-heading text-base leading-snug font-medium">Agent</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Options for the Agent chat: the code sandbox, local MCP servers and approvals. MCP servers and documents are managed on the Integrations and Knowledge pages.
        </p>
      </div>

      <Row
        label="Code sandbox worker"
        hint="Address and token of the sandbox worker (see sandbox-worker/README.md). Python tools appear in the Agent chat once both are set."
      >
        <div className="space-y-2">
          <input className={input} placeholder="http://127.0.0.1:8787" value={url} onChange={e => setUrl(e.target.value)} aria-label="Sandbox worker URL" />
          <input
            className={input}
            type="password"
            autoComplete="off"
            placeholder={settings.hasSandboxToken ? 'Token stored (leave blank to keep)' : 'Worker token'}
            value={token}
            onChange={e => setToken(e.target.value)}
            aria-label="Sandbox worker token"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void saveSandbox()} disabled={busy !== null}
              className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50">
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => void test()} disabled={busy !== null || !settings.sandboxUrl || !settings.hasSandboxToken}
              className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" onClick={generateToken} disabled={busy !== null}
              className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
              Generate token
            </button>
            {settings.hasSandboxToken && (
              <button type="button" onClick={() => void save({ sandboxToken: '' })} disabled={busy !== null}
                className="text-xs text-muted-foreground underline">
                Remove token
              </button>
            )}
          </div>
        </div>
        <details className="mt-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium">How to start the worker</summary>
          <p className="mt-2 text-muted-foreground">
            The worker is a small separate program that runs the code in locked-down containers. Run these on the machine that has Docker, from the project folder. Use the same token you save here.
          </p>
          {[
            'docker build -f sandbox-worker/Dockerfile.runtime -t freellmapi-sandbox:1 sandbox-worker',
            `SANDBOX_WORKER_TOKEN=${token || '<your token>'} node sandbox-worker/server.mjs`,
          ].map(cmd => (
            <div key={cmd} className="mt-2 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1">{cmd}</code>
              <button type="button" onClick={() => copy(cmd)} className="shrink-0 rounded border px-2 py-1 hover:bg-muted">Copy</button>
            </div>
          ))}
        </details>
      </Row>

      <Row label="Run code without asking" hint="Skip the approval prompt before each Python run. The sandbox has no network and no access to your files.">
        <Switch
          aria-label="Run code without asking"
          checked={settings.sandboxAutoApprove}
          onCheckedChange={checked => void save({ sandboxAutoApprove: checked })}
        />
      </Row>

      <Row label="Allow local MCP servers" hint="Lets you add MCP servers that start a program on the machine running this app. Only turn this on if you trust what you add.">
        <Switch
          aria-label="Allow local MCP servers"
          checked={settings.allowStdio}
          onCheckedChange={checked => void save({ allowStdio: checked })}
        />
      </Row>

      {message && (
        <p className={`mt-3 text-xs ${message.ok ? 'text-muted-foreground' : 'text-destructive'}`}>{message.text}</p>
      )}
    </>
  )
}
