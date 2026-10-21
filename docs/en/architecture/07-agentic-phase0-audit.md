# Phase 0 audit: MCP client, code sandbox, knowledge base, voice

Status: static audit. Nothing was built, linted, tested or run; the findings come from reading the code. A baseline of build, lint, migration and test results is **not** part of this document and must come from CI or a separate environment, because this instance is deployed and must not be disturbed.

## 1. Baseline

| Item | Finding |
| --- | --- |
| Upstream | `tashfeenahmed/freellmapi`, remote `upstream` |
| Merge base | `19eb7e1c` (upstream `main` has since moved to `5f4b596c`) |
| Divergence | fork is 57 commits ahead, 17 behind |
| Fork delta | 310 files, +24,700 / -5,113 (playground, skills, projects, memories, recall) |
| Sync path | `scripts/sync-upstream.sh`, merges with `-X ours`, so fork edits win on conflict |
| Runtime | `engines`: Node >=20.18 <25; Docker image uses Node 20; `node:sqlite` fallback needs 22.13 |
| Tests | not run. Run via CI only |

Watch-out: `-X ours` means upstream fixes to a line the fork also edited are silently dropped. New code should live in new files, not edit shared ones.

## 2. Architecture map

Server (`server/src`, Express, SQLite via `better-sqlite3`, `node:sqlite` fallback):

- Routing and providers: `services/router.ts`, `lib/fallback-loop.ts` (single shared retry loop for chat, responses and messages surfaces), `providers/*` (about 40 adapters, `openai-compat.ts` is the base).
- Admin API, all behind `requireAuth`: `/api/conversations`, `/api/projects`, `/api/memories`, `/api/keys`, and others (`app.ts:240-282`).
- Inference API: `/v1/*` (chat, responses, messages, embeddings, rerank, search, images, video, audio), `/v1beta` Gemini, `/mcp` (this is an MCP **server** exposing the router; there is no MCP client).
- DB: migrations in `server/src/db/migrations`, newest `20261020_000001_key_last_healthy_at.ts`.

Client (`client/src`): `pages/PlaygroundPage.tsx` (1,856 lines), `components/playground/*`, `lib/playground-*`.

### Chat is client-orchestrated today

The browser calls `/v1/chat/completions` itself, assembles the SSE stream (`lib/playground-stream.ts`, which ignores `tool_calls` deltas), and `PUT`s the **whole transcript** to `/api/conversations/:id` after each exchange (`routes/conversations.ts`).

- Storage is one JSON blob of `ChatMessage[]`, capped at 2 MB (`MAX_MESSAGES_BYTES`).
- Roles are only `user` and `assistant`. No `tool` role, tool-call IDs, run status or approvals.
- Conversations are scoped per `user_id`; another account's id answers 404.
- A `playground_chat_turns` table is a denormalised recall index kept in sync on every write.

Consequence: tool loops, cancellation, approvals and voice cannot live in the browser. Phase 1 needs a server-side orchestrator with relational run/message/tool-call tables; the blob format stays readable for old conversations.

### Reusable components

| Need | Reuse |
| --- | --- |
| Model selection and failover | `runFallbackLoop`; keep unchanged, call it from the orchestrator |
| Auth and per-user scoping | `requireAuth`, `user_id` pattern from conversations and memories |
| Secret storage | `lib/crypto.ts` AES-256-GCM (for MCP credentials) |
| SSRF guard | `lib/guarded-dispatcher.ts`, `services/custom-endpoint.ts` (for remote MCP URLs, OAuth endpoints) |
| Embeddings with fixed-family routing | `services/embeddings.ts`, already refuses cross-model failover |
| Rerank | `services/rerank.ts` (Cohere and custom endpoints only) |
| Document text extraction | `client/src/lib/document-extract.ts` (browser-side PDF/DOCX; ingestion needs a server-side equivalent) |
| Artifacts UI | `lib/artifacts.ts`, `components/playground/artifact-panel.tsx` |
| Speech in/out (browser) | `lib/speech.ts`, `lib/transcription.ts`, `dictation-button.tsx`, `lib/waveform.ts` |
| Dashboard flags | `getSetting()` settings table (runtime-tunable, env fallback), as used by guardrails and cache |
| Migrations | additive files in `db/migrations` |
| Event/log redaction | `lib/log-redaction.ts`, `lib/error-redaction.ts` |

## 3. Capability matrix (from code; provider-level support not verified live)

| Capability | Path | Status |
| --- | --- | --- |
| Tool calling on `/v1/chat/completions` | `tools`, `tool_calls` passthrough, plain-text tool-call rescue | Works. Per-model support is a catalog/custom-model flag (`20260706_000002_custom_model_tool_support`), so routing must filter on it |
| Tool calling in Playground | none (`tool_calls` deltas ignored) | Missing |
| Streaming | SSE with usage frame; fusion has its own frames | Works; no event types beyond OpenAI chunks |
| Embeddings | `/v1/embeddings`, family-pinned failover | Works. Family, platform and dimensions are recorded, which is what the knowledge index needs |
| Transcription | `/v1/audio/transcriptions`, multipart, `services/media.ts` (groq, cloudflare, typhoon, custom, others) | Works; latency and streaming/partial results unknown |
| Speech | `/v1/audio/speech`, raw bytes (speechify, pollinations, electronhub, custom, others) | Works; returns whole file, no chunked audio |
| Rerank | `/v1/rerank` | Cohere and custom only |
| Server-side vector store | none | Missing |
| Code execution | none | Missing |
| MCP client | none (only `/mcp` server) | Missing |

Open question for each phase: confirm with the deployed key pool which providers actually serve tools, embeddings, transcription and speech. The dashboard's media and models pages already list this at runtime; export it instead of probing from here.

## 4. Feature flags

Follow the existing precedence: settings-table value, then env var, then default off.

| Flag | Env | Default |
| --- | --- | --- |
| `feature_mcp_client` | `FEATURE_MCP_CLIENT` | off |
| `feature_sandbox` | `FEATURE_SANDBOX` | off (also requires `SANDBOX_WORKER_URL`) |
| `feature_knowledge` | `FEATURE_KNOWLEDGE` | off |
| `feature_voice` | `FEATURE_VOICE` | off |

A disabled feature hides its UI and answers its routes with 404, so `/v1` behaviour stays identical.

## 5. Decision records

### ADR-1: Storage

- Decision: new relational tables (`chat_runs`, `chat_messages`, `chat_tool_calls`, `chat_artifacts`, and later `kb_*`), added by additive migrations. Old `playground_conversations.messages` stays as is and is read-only legacy; a conversation is upgraded lazily on first server-side run.
- Why: the blob has no tool roles, is capped at 2 MB, and a run needs row-level status updates and crash recovery.
- Vectors: start with `sqlite-vec` loaded into the existing SQLite connection, keyed per index by embedding family and dimensions. Risk: the extension must load under both `better-sqlite3` and `node:sqlite` and in the Docker and desktop builds. If it cannot, fall back to brute-force cosine in-process (fine up to roughly 50k chunks) behind the same interface. Decide after checking packaging, not before.
- Binary files (uploads, artifacts): disk under the data directory, referenced by hash from rows; included in backups (`services/backups.ts` must be extended).

### ADR-2: Execution isolation

- Decision: sandbox is a separate worker process or container with a narrow HTTP API (`SandboxExecutor`: submit, status, cancel, fetch outputs). The main server never gets a Docker socket.
- Why: the main process holds every provider key and the database.
- Worker limits: non-root, read-only root, no network by default, CPU/memory/pids/disk/output/time limits, no secrets mounted, workspace destroyed after each job.
- Scope: private single-user installs only. A shared or public service needs a separate authn/authz/quota workstream, as upstream states ("single-user by design").
- Open: container runtime on the deployed host (Docker vs rootless Podman vs gVisor). Needs the host owner's input before Phase 3.

### ADR-3: Audio transport

- Decision: chained pipeline. Browser records and does voice-activity detection, uploads a turn to `/v1/audio/transcriptions`, the transcript enters the same orchestrator as typed input, the reply is split by sentence and each sentence goes to `/v1/audio/speech`, played in order.
- Why: it reuses existing routes and works with free providers. Providers return whole files, so latency comes from sentence-level chunking, not streaming audio.
- Barge-in: client stops playback, aborts the run, discards queued audio, and stores only the text actually spoken.
- Not now: realtime/WebRTC audio. Free providers do not offer it.

### ADR-4: Where orchestration lives

New `server/src/services/conversations/` calls the existing fallback loop as a client. The router is not modified; capability filtering (tools required, vision required) is passed in as a candidate filter, so it composes with `-X ours` merges.

## 6. Integration points per feature

| Feature | Hook |
| --- | --- |
| Foundation | new `routes/runs.ts` mounted next to `conversationsRouter`; SSE events from `shared/` types |
| MCP | tools registered in `services/tools/`; settings UI as a new Integrations page; credentials via `lib/crypto.ts` |
| Sandbox | tool `run_python` in the registry; outputs become `chat_artifacts` rows rendered by the artifact panel |
| Knowledge | tool `search_knowledge` in the registry; ingestion queue persisted in SQLite and resumed at start-up |
| Voice | thin client layer over the orchestrator; no separate history |

## 7. Risks found

1. `-X ours` upstream sync can drop upstream fixes on shared files. Keep changes additive and in new files.
2. `PlaygroundPage.tsx` is 1,856 lines; adding four features to it will not scale. New UI goes in `client/src/features/*` and the page only mounts it.
3. Deployed instance: every migration runs on next start. All migrations must be additive and tested in CI first; take a backup (`/api/backups`) before deploying.
4. Tool-call rescue from plain text exists in the proxy; the orchestrator must use the already-normalised output, not parse again.
5. No `tool` role in stored history: switching models mid-run needs the tool-call/result pairing kept in `chat_tool_calls`, not rebuilt from text.
6. Node 18 is on the host PATH; the repo requires >=20.18. Irrelevant for the deployed app but matters for any local tooling.

## 8. Exit criteria for Phase 0

- Baseline test results: **pending**, to be produced in CI.
- Provider capability export from the running dashboard: **pending**, needs the deployed key pool.
- Container runtime decision (ADR-2): **pending**, needs the host owner.
- Vector index packaging check (ADR-1): **pending**, a read-only check of `sqlite-vec` prebuilds for the Docker and desktop targets.

Phase 1 can start on the orchestrator and the tables, since they do not depend on the pending items.
