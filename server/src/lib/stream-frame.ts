// The shape of one parsed streaming frame from a provider.
//
// Normally it is an OpenAI `chat.completion.chunk`, but providers add to it:
// Groq and others send an in-band `{ "error": ... }` frame inside a 200 stream,
// deltas can carry `reasoning`, tool-call deltas carry an `index` and a Gemini
// `thought_signature`, and vendors put their own fields on top. So every known
// field is optional and unknown ones are allowed, rather than trusting the
// strict ChatCompletionChunk or reaching for `any`.

import type { TokenUsage } from '@freellmapi/shared/types.js';

export interface StreamToolCallDelta {
  index?: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
  thought_signature?: string;
  thoughtSignature?: string;
}

export interface StreamDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: StreamToolCallDelta[];
  [field: string]: unknown;
}

export interface StreamChoice {
  index?: number;
  delta?: StreamDelta;
  finish_reason?: string | null;
  [field: string]: unknown;
}

export interface StreamFrame {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: StreamChoice[];
  usage?: TokenUsage;
  error?: { message?: string; code?: unknown; [field: string]: unknown } | string | null;
  [field: string]: unknown;
}

/** View a frame the provider adapter yielded as a StreamFrame (the one place the loose shape is asserted). */
export function asStreamFrame(chunk: unknown): StreamFrame {
  return chunk as StreamFrame;
}

/** The message of an in-band error frame: its `message`, else the error JSON cut to 200 characters. */
export function frameErrorMessage(frame: StreamFrame): string {
  const error = frame.error;
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return (JSON.stringify(error) ?? '').slice(0, 200);
}
