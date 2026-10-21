// Streamed events and statuses for server-side conversation runs.
//
// One run answers one user turn: it may stream text, call tools, feed their
// results back to the model and continue, then end in exactly one terminal
// event (`run.completed` or `run.failed`). The wire format is SSE with one
// JSON object per `data:` frame, discriminated by `type`.

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type ToolCallStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'cancelled';

/**
 * What is known about a tool call's effect. `uncertain` means the call may
 * have taken effect but its result was lost; it is never retried automatically.
 */
export type ToolCallOutcome = 'unknown' | 'ok' | 'error' | 'uncertain';

/** Where a tool comes from; used for namespacing and permission policy. */
export type ToolSource = 'builtin' | 'mcp' | 'sandbox' | 'knowledge';

export type RunErrorCode =
  | 'cancelled'
  | 'max_rounds'
  | 'timeout'
  | 'no_capable_model'
  | 'provider_exhausted'
  | 'tool_error'
  | 'internal';

export interface RunCitation {
  /** Stable id the model quotes, such as `kb:12#3`. */
  id: string;
  title: string;
  /** Page or heading locator inside the source, when known. */
  location?: string;
  url?: string;
}

export interface RunArtifact {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export type RunEvent =
  | { type: 'run.started'; runId: string; conversationId: number }
  | { type: 'message.delta'; runId: string; text: string }
  | { type: 'message.reasoning'; runId: string; text: string }
  | {
      type: 'tool.started';
      runId: string;
      callId: string;
      name: string;
      source: ToolSource;
      arguments: unknown;
    }
  | {
      type: 'tool.approval_required';
      runId: string;
      callId: string;
      name: string;
      source: ToolSource;
      arguments: unknown;
    }
  | {
      type: 'tool.completed';
      runId: string;
      callId: string;
      status: Extract<ToolCallStatus, 'completed' | 'failed' | 'denied' | 'cancelled'>;
      outcome: ToolCallOutcome;
      /** Bounded summary for display; the full result stays server-side. */
      summary: string;
    }
  | { type: 'artifact.created'; runId: string; callId?: string; artifact: RunArtifact }
  | { type: 'citation.added'; runId: string; citation: RunCitation }
  | { type: 'run.failed'; runId: string; code: RunErrorCode; message: string }
  | { type: 'run.completed'; runId: string; status: Extract<RunStatus, 'completed' | 'cancelled'> };

export type RunEventType = RunEvent['type'];

/** Events after which no more events are sent for the run. */
export function isTerminalRunEvent(event: RunEvent): boolean {
  return event.type === 'run.failed' || event.type === 'run.completed';
}
