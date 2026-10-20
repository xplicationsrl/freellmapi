import type { ChatMessage } from '@freellmapi/shared/types.js';
import type { RouteResult } from '../services/router.js';
import { contentToString } from './content.js';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';
import type { StreamFrame } from './stream-frame.js';

export function completionPromptToMessages(prompt: string, suffix?: string): ChatMessage[] {
  const hasSuffix = suffix !== undefined && suffix.length > 0;
  return [
    {
      role: 'system',
      content: [
        'You are a code autocomplete engine.',
        'Complete at the cursor and return only the text to insert.',
        'Do not include markdown fences, explanations, or repeat surrounding code.',
      ].join(' '),
    },
    {
      role: 'user',
      content: hasSuffix
        ? `Prefix before cursor:\n${prompt}\n\nSuffix after cursor:\n${suffix}\n\nCompletion to insert:`
        : `Prefix before cursor:\n${prompt}\n\nCompletion to insert:`,
    },
  ];
}

/** The parts of a non-streaming chat result the legacy /completions shape reads. */
interface ChatResultLike {
  choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } | null }>;
}

export function completionTextFromChat(result: ChatResultLike | null | undefined): string {
  return contentToString(result?.choices?.[0]?.message?.content ?? '');
}

// Non-streaming counterpart of streamReasoningText: reasoning models attach
// thinking to the completed message as `reasoning_content` or `reasoning`.
// Included in the chars/4 output estimate so analytics and the rate-limit
// ledger aren't undercounted for thinking models. (#764)
export function completionReasoningText(result: ChatResultLike | null | undefined): string {
  const msg = result?.choices?.[0]?.message;
  const r = msg?.reasoning_content ?? msg?.reasoning;
  return typeof r === 'string' ? r : '';
}

export function completionIdFromChat(id: string | undefined): string {
  if (!id) return `cmpl-${Date.now()}`;
  return id.startsWith('cmpl-') ? id : `cmpl-${id}`;
}

export function legacyCompletionChunk(route: RouteResult, chunk: ChatCompletionChunk | StreamFrame | null | undefined, text: string) {
  return {
    id: completionIdFromChat(chunk?.id),
    object: 'text_completion',
    created: chunk?.created ?? Math.floor(Date.now() / 1000),
    model: route.modelId,
    choices: [{
      text,
      index: chunk?.choices?.[0]?.index ?? 0,
      logprobs: null,
      finish_reason: chunk?.choices?.[0]?.finish_reason ?? null,
    }],
  };
}
