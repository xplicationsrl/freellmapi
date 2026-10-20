import { z } from 'zod';
import { fusionConfigSchema } from '../services/fusion.js';
import { samplingParamSchemaFields } from './sampling-params.js';

// Echo-tolerant tool calls: agents replay OUR responses back as history, and
// not all of them preserve the strict OpenAI shape. `type` may be dropped
// (re-added on forward), Gemini-lineage agents (Qwen Code, AionUI) often
// send `arguments` as a parsed object instead of a JSON string, and `id` may
// be missing or empty (ids aren't a Gemini concept) — all get normalized
// below rather than 400-ing the whole session. Missing ids are synthesized
// and paired with their tool-result messages by order. (#200)
export const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1),
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
  }),
  thought_signature: z.string().optional(),
});

export const toolCallArgsToString = (args: string | Record<string, unknown>): string =>
  typeof args === 'string' ? args : JSON.stringify(args);

// OpenAI multimodal envelope. Clients like opencode / continue.dev send
// content as an array of typed blocks even when only text is present, and
// Gemini-lineage agents send part-style blocks like `{ "text": "..." }` with
// no `type` at all. Accept any object (or bare string) as a block; flatten to
// string for providers that don't support arrays (Cohere, Cloudflare).
// Non-text blocks pass z validation but get dropped by contentToString —
// vision/audio still isn't supported. (#200)
export const contentBlockSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
export const contentSchema = z.union([z.string(), z.array(contentBlockSchema)]);

export const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: contentSchema,
  name: z.string().optional(),
});

// OpenAI's newer SDKs send the system prompt as role:"developer"; accept it
// and forward as "system" — none of the routed providers know the developer
// role. (#200)
export const developerMessageSchema = z.object({
  role: z.literal('developer'),
  content: contentSchema,
  name: z.string().optional(),
});

export const userMessageSchema = z.object({
  role: z.literal('user'),
  content: contentSchema,
  name: z.string().optional(),
});

// Assistant turns may carry empty/null content and no tool_calls — OpenAI
// accepts these in conversation history (a turn that produced no visible text,
// a placeholder, a tool turn whose content was emptied), and clients replay
// them verbatim. We accept them too and coerce empty/null content to "" before
// forwarding (see message build below) rather than 400-ing a payload OpenAI
// would take. (#165)
export const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([contentSchema, z.null()]).optional(),
  name: z.string().optional(),
  // tool_calls: null (not just missing) is what several agents replay for
  // no-tool assistant turns — aionrs (AionUI's engine) writes it into every
  // session-resumed assistant echo. Treated as absent. (#200)
  tool_calls: z.array(toolCallSchema).nullable().optional(),
  // Thinking trace echoed back by a client. DeepSeek thinking models on
  // OpenCode Zen 400 ("reasoning_content in thinking mode must be passed back")
  // unless the prior turn's reasoning_content is replayed, so keep it through
  // validation instead of stripping it. See issue #255.
  reasoning_content: z.string().nullable().optional(),
  // Moonshot's "partial" prefill flag. A plain z.object (no .passthrough())
  // would silently strip it; keep it through validation so it can be forwarded
  // to Moonshot/Kimi models, which document it. See issue #1038.
  partial: z.boolean().optional(),
});

// Tool results may arrive with null/missing content (a tool that returned
// nothing) and a missing/empty tool_call_id (Gemini-lineage agents) — coerced
// to "" and paired by order with the preceding tool_calls respectively. (#200)
export const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.union([contentSchema, z.null()]).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

// Legacy function-calling shape (pre-tools OpenAI API). Old clients still
// replay these in history; forwarded as a tool message. (#200)
export const functionMessageSchema = z.object({
  role: z.literal('function'),
  name: z.string().min(1),
  content: z.union([contentSchema, z.null()]).optional(),
});

export const toolDefinitionSchema = z.object({
  // Some agents omit `type` on tool definitions; re-defaulted to 'function'
  // on forward. (#200)
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

export const toolChoiceSchema = z.union([
  // 'any' is the Mistral/Gemini wording for OpenAI's 'required'; mapped on
  // forward. (#200)
  z.enum(['none', 'auto', 'required', 'any']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

export const stopSchema = z.union([z.string(), z.array(z.string()).min(1).max(64)]);

export function providerSafeStop(stop: string | string[] | undefined): string | string[] | undefined {
  if (!Array.isArray(stop)) return stop;
  return stop.slice(0, 4);
}

export const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    developerMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
    functionMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  // Some clients send max_tokens <= 0 (or -1) to mean "no limit"; accepted and
  // treated as unset on forward. (#200)
  max_tokens: z.number().int().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: stopSchema.optional(),
  stream: z.boolean().optional(),
  stream_options: z.object({
    include_usage: z.boolean().optional(),
  }).optional(),
  // Top-level tool knobs may arrive as explicit nulls from clients that
  // serialize every field of their request struct; all treated as absent
  // and never forwarded as null. (#200)
  tools: z.array(toolDefinitionSchema).nullable().optional(),
  tool_choice: toolChoiceSchema.nullable().optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  // Fusion config — only meaningful when `model` is the virtual "fusion" id.
  // Ignored for every other model. See services/fusion.ts.
  fusion: fusionConfigSchema.optional(),
  // Extended sampling + structured-output params (top_k, seed, penalties,
  // logit_bias, logprobs, response_format, max_completion_tokens…), forwarded
  // per the platform policy in lib/sampling-params.ts.
  ...samplingParamSchemaFields,
});
