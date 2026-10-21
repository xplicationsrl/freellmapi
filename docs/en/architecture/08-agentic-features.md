# Agent chat: MCP tools, code sandbox, knowledge base, voice

The **Agent** page (`/agent`) runs a chat on the server. The model can call tools in a loop, with approvals, cancellation and limits. Four optional features plug into it. All four are off by default, and `/v1` behaviour is unchanged when they are off.

For the audit and design decisions behind this, see [07-agentic-phase0-audit.md](07-agentic-phase0-audit.md).

## Turning features on

| Feature | Turn on | Also needs |
| --- | --- | --- |
| MCP client | `FEATURE_MCP_CLIENT=1` | `MCP_ALLOW_STDIO=1` only if you want local (stdio) servers |
| Code sandbox | `FEATURE_SANDBOX=1` | a running [sandbox worker](../../../sandbox-worker/README.md), `SANDBOX_WORKER_URL`, `SANDBOX_WORKER_TOKEN` |
| Knowledge base | `FEATURE_KNOWLEDGE=1` | at least one embedding provider with a key |
| Voice mode | `FEATURE_VOICE=1` | a transcription model and a speech model with keys |

Each flag can also be set at runtime in the settings table as `feature_mcp_client`, `feature_sandbox`, `feature_knowledge`, `feature_voice` (`1`/`0`); the settings value wins over the environment. Servers already saved in the Integrations page reconnect at start-up when the MCP flag is on; after switching a flag at runtime, use **Test connection** (MCP) or restart.

Other settings: `SANDBOX_AUTO_APPROVE=1` skips the approval prompt before each code run.

## How a run works

`POST /api/runs` streams one run as server-sent events: `run.started`, `message.delta`, `tool.approval_required`, `tool.started`, `tool.completed`, `artifact.created`, `citation.added`, then exactly one of `run.completed` or `run.failed`. Types live in `shared/conversation-events.ts`.

- Model calls go through this server's own `/v1/chat/completions`, so routing, fallover, cooldowns and the cache behave as for any client.
- With tools offered and model `auto`, the run picks a model that supports tool calling.
- Limits: 6 tool rounds (up to 12 per request), 180 s per run, 60 s per tool, 12,000 characters of tool output sent back to the model.
- Each tool call is recorded in `chat_tool_calls` by the call id the model saw. A completed call is never executed again. A call whose result was lost after it may have taken effect is marked `uncertain` and not retried. Runs and calls left over by a restart are marked failed or uncertain at start-up.
- Closing the page or pressing Stop cancels the model call and any running tool.
- Arguments are checked against the tool's JSON Schema before execution. Tools that ask for approval wait until you answer, for up to 5 minutes.
- Other endpoints: `GET /api/runs/:id`, `POST /api/runs/:id/cancel`, `POST /api/runs/:id/tools/:callId/approval`, `GET /api/runs/tools`, `GET /api/runs/features`, `GET /api/runs/artifacts/:id`.

Generated files are stored under `artifacts/` next to the database and expire after 7 days.

## MCP client

Add servers on the **Integrations** page. Remote servers use Streamable HTTP; local servers use stdio and run a program on the host, so they are disabled unless `MCP_ALLOW_STDIO=1`.

- Credentials (HTTP headers, stdio environment) are stored AES-256-GCM encrypted, shown only as names, and are separate from provider keys. A stdio server does not inherit the application's environment.
- Remote URLs go through the same address checks as custom providers: cloud-metadata and link-local targets are blocked, loopback and private addresses need "allow a local or private network address" on that server, redirects are not followed, and the address is checked at connect time.
- Tools are named `m<server id>__<tool>`, so two servers with the same tool name cannot collide. Each tool is **Allow**, **Ask** (approval before each call) or **Hide**; new tools default to the server's setting, which defaults to Ask.
- Only tools you have enabled in the Agent page are offered, and the offered list is capped at 24 per turn, preferring tools that match the message.
- Not implemented: OAuth for remote servers (use a header token), MCP resources, sampling and elicitation, marketplace installs.

## Code sandbox

The tool `sandbox__run_python` sends code to a separate worker that runs it in a locked-down container (no network, read-only filesystem, non-root, CPU/memory/process/time limits). The main server never talks to a container daemon and the worker holds no keys. Files attached in the Agent page are copied in; files the code writes are returned as downloadable artifacts, and PNG images are previewed. Setup and limits: [sandbox-worker/README.md](../../../sandbox-worker/README.md).

Containers share the host kernel. Use this on a private install; do not expose it to untrusted users without a stronger boundary.

## Knowledge base

Create a base on the **Knowledge** page, add `.txt`, `.md`, `.pdf` (text layer only) or `.docx` files, then tick the base in the Agent page. The model gets a `knowledge__search` tool, and answers carry ids such as `[kb:12#3]` that map to document, page and heading.

- PDF and Word text is extracted in the browser; the server stores the extracted text so indexing resumes after a restart.
- A base pins its embedding model and dimensions on first use. Indexing never falls over to a different model. To change models, use **Switch embedding model**, which re-embeds every document.
- Re-uploading identical content is a no-op; changed content under the same name replaces the old document and its passages in one step. Deleting a document removes its passages from retrieval immediately.
- Retrieval combines vector similarity and keyword scoring, removes near-duplicates, and stays within a context budget. Weak or no match is reported to the model so it says so instead of guessing; a failed search is reported as "documents were NOT checked".
- Document text is passed to the model as data with an instruction to ignore commands inside it.
- Vectors are compared in process (suitable for tens of thousands of passages). Scanned PDFs, OCR, spreadsheets and web pages are not supported.

## Voice mode

Voice mode in the Agent page uses the existing routes: microphone, `/v1/audio/transcriptions`, a normal run, then `/v1/audio/speech` one sentence at a time, played in order. Speaking over the assistant interrupts it: queued audio is dropped, the run is cancelled, and the conversation keeps only the part you actually heard. Raw audio is not stored. The panel shows transcription, first-token, speech-generation and playback-start times for the last turn. It is not offline: transcription and speech use whichever providers your keys route to.

## Deploying and upgrading

- Migrations `20261021_000001` (runs, tool calls, artifacts), `20261021_000002` (MCP servers) and `20261021_000003` (knowledge) are additive and reversible. Existing keys, settings and conversations are untouched.
- **Back up before upgrading** (`/api/backups` or copy the data directory). Knowledge documents and indexes are in the database; generated artifacts are in `artifacts/` and are temporary by design.
- Rollback: restore the backup, or run `npm run db:migration:down` three times from the new version before returning to the old one.
- Merging upstream: the new code lives in new files (`services/conversations`, `services/tools`, `services/mcp-client`, `services/sandbox`, `services/knowledge`, `routes/runs.ts`, `routes/mcp-servers.ts`, `routes/knowledge.ts`, `client/src/features/agent`). Shared files changed are small: `app.ts`, `index.ts`, `routes/conversations.ts` (one optional field), `App.tsx`, `app-nav.tsx`. `sync-upstream.sh` prefers fork edits on conflict, so re-check those five after each sync.
- The new pages are English only; their labels have no locale entries yet.

## Known gaps

- Nothing here has been built, type-checked or tested in CI yet.
- The Playground page itself has no tool use; use the Agent page.
- After a reload, the Agent page restores the last conversation and rebuilds tool status from the stored runs, but not the tool arguments, generated files or citations of earlier replies.
