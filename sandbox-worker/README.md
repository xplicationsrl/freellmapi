# Sandbox worker

Runs the Playground's `sandbox__run_python` tool. Separate from the main server on purpose: this is the only component that talks to a container daemon, and it holds no provider keys or application data.

## Setup

1. Build the runtime image:
   `docker build -f sandbox-worker/Dockerfile.runtime -t freellmapi-sandbox:1 sandbox-worker`
2. Start the worker **on the host** (Node 20+, `docker` CLI on PATH):
   `SANDBOX_WORKER_TOKEN=<random 32+ chars> node sandbox-worker/server.mjs`
3. In the app, open **Settings > Agent**, enter the worker URL (for example `http://127.0.0.1:8787`) and the same token, then **Save** and **Test connection**. (`SANDBOX_WORKER_URL` and `SANDBOX_WORKER_TOKEN` environment variables also work as a fallback.)

Until both are set the tool is not offered.

## What each job gets

Non-root user, read-only root filesystem, `--network none`, all capabilities dropped, `no-new-privileges`, 1 CPU, 512 MB RAM (no swap), 128 processes, 10 MB per written file, 64 MB `/tmp`. Only files the run explicitly attached are copied in. The container is killed on timeout or cancellation and removed afterwards; containers left by a crash are removed when the worker starts.

Output: stdout/stderr (1 MB cap), up to 10 files of 5 MB (10 MB total). Symlinks and directories are ignored.

## Approval

The tool asks for approval before each run. **Settings > Agent > Run code without asking** turns that off.

## Not covered

Containers share the host kernel. This is fit for a private install used by its owner. Before letting unrelated or untrusted users run code, put the worker behind a stronger boundary (gVisor, Firecracker, a dedicated VM).
