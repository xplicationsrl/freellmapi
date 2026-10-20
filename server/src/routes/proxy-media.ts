import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { secondsUntilNextMonth } from '../services/key-budget.js';
import { runEmbeddings, EmbeddingsError } from '../services/embeddings.js';
import { runRerank, RerankError, rerankRetryAfterSec } from '../services/rerank.js';
import { runSearch, SearchError, searchRetryAfterSec, listSearchEngines } from '../services/search.js';
import { runDecision, DecisionError, decisionRetryAfterSec, listDecisionModels, DECISION_QUESTION_TYPES } from '../services/decision.js';
import { runImageGeneration, runVideoGeneration, runSpeech, runTranscription, inlineImageUrls, MediaError, MAX_TRANSCRIPTION_BYTES } from '../services/media.js';
import { retryAfterSeconds } from '../lib/retry-hint.js';
import { safeHeaderValue } from '../lib/header-value.js';
import { requireInferenceAuth } from '../lib/inference-auth.js';
import { errorMessage, errorProps } from '../lib/error-props.js';

// Non-chat /v1 inference endpoints: embeddings, rerank, search, image / video /
// speech generation and transcription. Mounted by proxyRouter (routes/proxy.ts)
// so every path stays under /v1.
export const mediaProxyRouter = Router();

// OpenAI-compatible embeddings endpoint, routed through the embeddings family
// catalog: `model: "auto"` (or omitted) → the configured default family; a
// family name or provider model id → that family's provider chain. Failover
// only happens WITHIN a family (same model on another provider) — never across
// models, since vectors from different models are incompatible.
const EmbeddingsBody = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]),
  // Optional output-dimension override forwarded to providers that support MRL
  // truncation (NVIDIA NeMo NIM, Google Gemini Embedding, OpenAI v3). Validation
  // only — bounds checking happens upstream (the provider rejects out-of-range
  // values with a clear 400).
  dimensions: z.number().int().positive().optional(),
});

mediaProxyRouter.post('/embeddings', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = EmbeddingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `input` is required', type: 'invalid_request_error' } });
    return;
  }
  const inputs = Array.isArray(parsed.data.input) ? parsed.data.input : [parsed.data.input];
  try {
    const result = await runEmbeddings(parsed.data.model, inputs, parsed.data.dimensions);
    res.json({
      object: 'list',
      data: result.vectors.map((values, i) => ({ object: 'embedding', index: i, embedding: values })),
      model: result.family,
      provider: result.platform,
      usage: { prompt_tokens: result.inputTokens, total_tokens: result.inputTokens },
    });
  } catch (err) {
    const status = err instanceof EmbeddingsError ? err.status : 502;
    const code = err instanceof EmbeddingsError ? inferenceBudgetCode(err, res) : {};
    const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'server_error';
    res.status(status).json({ error: { message: `embedding error: ${errorMessage(err, 'unknown')}`, type, ...code } });
  }
});

// Cohere/Jina-style rerank over the key pool (#1029). No catalog: a Cohere key
// or a custom OpenAI-compatible endpoint exposing POST {base_url}/rerank is a
// provider; the first success wins, custom endpoints tried first.
const RerankBody = z.object({
  model: z.string().optional(),
  query: z.string().min(1),
  documents: z.array(z.string()).min(1),
  top_n: z.number().int().positive().optional(),
});

mediaProxyRouter.post('/rerank', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = RerankBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `query` and `documents` are required', type: 'invalid_request_error' } });
    return;
  }
  try {
    const result = await runRerank(parsed.data.model, parsed.data.query, parsed.data.documents, parsed.data.top_n);
    res.json({
      results: result.results.map(r => ({
        index: r.index,
        relevance_score: r.relevanceScore,
        document: { text: r.document },
      })),
      model: result.modelId,
      provider: result.platform,
    });
  } catch (err) {
    const status = err instanceof RerankError ? err.status : 502;
    if (err instanceof RerankError) {
      const retryAfter = rerankRetryAfterSec(err);
      if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
    }
    const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'server_error';
    res.status(status).json({ error: { message: `rerank error: ${errorMessage(err, 'unknown')}`, type } });
  }
});

// Web search over the key pool (#1174). Engines are catalog rows (Tavily,
// Exa, Firecrawl, Linkup, plus custom relays speaking Tavily's wire shape);
// the first engine that returns hits wins. See services/search.ts.
const SearchBody = z.object({
  query: z.string().min(1),
  max_results: z.number().int().positive().optional(),
  topic: z.enum(['general', 'news']).optional(),
  include_answer: z.boolean().optional(),
  engine: z.string().min(1).optional(),
});

mediaProxyRouter.post('/search', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = SearchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `query` is required', type: 'invalid_request_error' } });
    return;
  }
  // A departed client drops the upstream search instead of spending a credit.
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  try {
    const result = await runSearch(parsed.data.query, {
      maxResults: parsed.data.max_results,
      topic: parsed.data.topic,
      includeAnswer: parsed.data.include_answer,
      engine: parsed.data.engine,
      signal: abort.signal,
    });
    res.json({
      query: result.query,
      ...(result.answer !== undefined ? { answer: result.answer } : {}),
      results: result.results,
      provider: result.provider,
      engine: result.engine,
    });
  } catch (err) {
    if (res.headersSent || abort.signal.aborted) return;
    const status = err instanceof SearchError ? err.status : 502;
    if (err instanceof SearchError) {
      const retryAfter = searchRetryAfterSec(err);
      if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
    }
    const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'server_error';
    res.status(status).json({
      error: {
        message: `search error: ${errorMessage(err, 'unknown')}`,
        type,
        ...(err instanceof SearchError && err.code ? { code: errorProps(err).code } : {}),
      },
    });
  }
});

// The engines a caller can pin with `engine` on POST /v1/search.
mediaProxyRouter.get('/search/engines', (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  res.json({
    object: 'list',
    data: listSearchEngines()
      .filter(e => e.enabled)
      .map(e => ({
        id: e.engineId,
        object: 'search_engine',
        provider: e.platform,
        name: e.displayName,
        available: e.healthyKeyCount > 0,
      })),
  });
});

// Decision models over the key pool. A decision model answers typed questions
// about `state` (pick one option, yes/no, or a score) with probabilities
// instead of generated text. Request shape is "System One":
//   { model?, state, questions: { <id>: { type, instructions, criteria? } } }
// Catalog rows only (Cloudflare Clef, OpenRouter Mercury Decide), on the keys
// the user already has for those platforms. Never used by chat routing.
// See services/decision.ts. /v1/systemone is an alias for System One clients.
const DecisionQuestionBody = z.object({
  type: z.enum(DECISION_QUESTION_TYPES),
  instructions: z.unknown().refine(v => v !== undefined && v !== null && v !== '', { message: 'instructions is required' }),
  criteria: z.unknown().optional(),
}).passthrough();

const DecisionBody = z.object({
  model: z.string().min(1).optional(),
  state: z.unknown().refine(v => v !== undefined && v !== null && v !== '', { message: 'state is required' }),
  questions: z.record(z.string().min(1).max(100), DecisionQuestionBody)
    .refine(q => Object.keys(q).length >= 1 && Object.keys(q).length <= 64, { message: 'questions must hold 1 to 64 entries' }),
});

async function handleDecision(req: Request, res: Response): Promise<void> {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = DecisionBody.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => `${e.path.join('.') || 'body'}: ${e.message}`).join('; ');
    res.status(400).json({ error: { message: `Invalid request: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  try {
    const { model, state, questions } = parsed.data;
    const result = await runDecision(
      { state, questions: questions as Parameters<typeof runDecision>[0]['questions'] },
      { model, signal: abort.signal },
    );
    res.json({
      object: 'decision',
      model: result.model,
      provider: result.provider,
      answers: result.answers,
      usage: result.usage,
    });
  } catch (err) {
    if (res.headersSent || abort.signal.aborted) return;
    const status = err instanceof DecisionError ? err.status : 502;
    if (err instanceof DecisionError) {
      const retryAfter = decisionRetryAfterSec(err);
      if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
    }
    const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'server_error';
    res.status(status).json({
      error: {
        message: `decision error: ${errorMessage(err, 'unknown')}`,
        type,
        ...(err instanceof DecisionError && err.code ? { code: errorProps(err).code } : {}),
      },
    });
  }
}

mediaProxyRouter.post('/decisions', handleDecision);
mediaProxyRouter.post('/systemone', handleDecision);

// The decision models a caller can pin with `model` on POST /v1/decisions.
mediaProxyRouter.get('/decisions/models', (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  res.json({
    object: 'list',
    data: listDecisionModels()
      .filter(m => m.enabled)
      .map(m => ({
        id: m.modelId,
        object: 'decision_model',
        provider: m.platform,
        name: m.displayName,
        context_window: m.contextWindow,
        available: m.healthyKeyCount > 0,
      })),
  });
});

// OpenAI-compatible image generation. Routed through the media catalog (its own
// table, never the chat router): `model: "auto"` (or omitted) tries every enabled
// image provider in order; a provider model id pins to that one. Failover is
// across providers, never across modalities. See services/media.ts.
const ImageBody = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1),
  n: z.number().int().positive().max(4).optional(),
  size: z.string().optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
});

function inferenceBudgetCode(error: { code?: string; retryAfterMs?: number }, res: Response): { code?: string } {
  // retryAfterMs is set by the embeddings/media services only when the whole
  // chain was rate limited (soonest stated back-off, budget resets included),
  // so it wins over the month-long budget reset when a sibling returns sooner.
  if (error.retryAfterMs !== undefined) res.setHeader('Retry-After', retryAfterSeconds(error.retryAfterMs));
  else if (error.code === 'quota_exceeded') res.setHeader('Retry-After', secondsUntilNextMonth());
  return error.code ? { code: error.code } : {};
}

function mediaErrorType(status: number): string {
  if (status === 400 || status === 413) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  return 'server_error';
}

mediaProxyRouter.post('/images/generations', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = ImageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `prompt` is required', type: 'invalid_request_error' } });
    return;
  }
  try {
    const result = await runImageGeneration(parsed.data.model, {
      prompt: parsed.data.prompt, n: parsed.data.n, size: parsed.data.size,
    });
    // `response_format: "b64_json"` means the caller wants the bytes, not a link.
    const data = parsed.data.response_format === 'b64_json'
      ? await inlineImageUrls(result.images, result.platform)
      : result.images;
    res.json({
      created: Math.floor(Date.now() / 1000),
      data,
      model: result.modelId,
      provider: result.platform,
    });
  } catch (err) {
    const status = err instanceof MediaError ? err.status : 502;
    const code = err instanceof MediaError ? inferenceBudgetCode(err, res) : {};
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({ error: { message: `image generation error: ${errorMessage(err, 'unknown')}`, type: mediaErrorType(status), ...code } });
  }
});

// Text-to-video generation. Providers may use a synchronous binary response
// (Pollinations) or an asynchronous queue internally (Hugging Face/fal.ai), but
// this gateway presents one bounded request and returns the completed MP4.
const VideoBody = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1),
  duration: z.number().int().min(1).max(120).optional(),
  aspect_ratio: z.enum(['16:9', '9:16']).optional(),
  image: z.string().url().optional(),
  seed: z.number().int().min(-1).max(2_147_483_647).optional(),
  audio: z.boolean().optional(),
});

mediaProxyRouter.post('/videos/generations', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = VideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: 'Invalid request: `prompt` is required and video options must use supported values',
        type: 'invalid_request_error',
      },
    });
    return;
  }
  // A video job runs for minutes, so a caller that hangs up must actually stop
  // the work: without this the gateway would keep polling the provider and then
  // fail over to a second one, both charged to the operator, for a response
  // nobody is waiting for. 'close' also fires on normal completion, which
  // writableEnded distinguishes.
  const clientAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientAbort.abort();
  });
  try {
    const result = await runVideoGeneration(parsed.data.model, {
      prompt: parsed.data.prompt,
      duration: parsed.data.duration,
      aspectRatio: parsed.data.aspect_ratio,
      image: parsed.data.image,
      seed: parsed.data.seed,
      audio: parsed.data.audio,
    }, clientAbort.signal);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Provider', safeHeaderValue(result.platform));
    res.setHeader('X-Model', safeHeaderValue(result.modelId));
    res.send(result.video);
  } catch (err) {
    // Nothing to report to a socket that is already gone.
    if (clientAbort.signal.aborted || res.writableEnded) return;
    const status = err instanceof MediaError ? err.status : 502;
    const code = err instanceof MediaError ? inferenceBudgetCode(err, res) : {};
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({
      error: { message: `video generation error: ${errorMessage(err, 'unknown')}`, type: mediaErrorType(status), ...code },
    });
  }
});

// OpenAI-compatible text-to-speech. Returns raw audio bytes (OpenAI's /audio/speech
// shape). Same media-catalog routing as images.
const SpeechBody = z.object({
  model: z.string().optional(),
  input: z.string().min(1),
  voice: z.string().optional(),
  response_format: z.string().optional(),
});

mediaProxyRouter.post('/audio/speech', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = SpeechBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `input` is required', type: 'invalid_request_error' } });
    return;
  }
  try {
    const result = await runSpeech(parsed.data.model, {
      input: parsed.data.input, voice: parsed.data.voice, format: parsed.data.response_format,
    });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('X-Provider', safeHeaderValue(result.platform));
    res.send(result.audio);
  } catch (err) {
    const status = err instanceof MediaError ? err.status : 502;
    const code = err instanceof MediaError ? inferenceBudgetCode(err, res) : {};
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({ error: { message: `speech error: ${errorMessage(err, 'unknown')}`, type: mediaErrorType(status), ...code } });
  }
});

// OpenAI-compatible speech-to-text (/v1/audio/transcriptions). Multipart form
// upload, held in memory only (multer memoryStorage — audio bytes never touch
// disk), routed through the STT provider chain in services/media.ts with the
// same key/failover/cooldown machinery as the other media endpoints. The STT
// registry (media_models, modality='transcription') is maintained by the
// published catalog's `transcriptionModels` array via catalog-sync, plus any
// OpenAI-compatible endpoint the operator registered themselves through
// POST /api/media/custom; on an install that has never synced one and has no
// custom row, the endpoint answers 503 with code 'no_transcription_models'.
//
// response_format: 'json' (default, {"text": ...}), 'text' (plain string),
// 'verbose_json' (OpenAI verbose shape when the provider returns segments,
// graceful fallback to the plain json shape otherwise), 'vtt' (only from
// providers that produce it natively — Cloudflare whisper). 'srt' is not
// produced natively by any configured provider and is refused with 400
// unsupported_format rather than synthesized.
const transcriptionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TRANSCRIPTION_BYTES, files: 1 },
});

const TRANSCRIPTION_FORMATS = new Set(['json', 'text', 'verbose_json', 'srt', 'vtt']);

function transcriptionBadRequest(res: Response, message: string, code?: string): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', ...(code ? { code } : {}) } });
}

mediaProxyRouter.post('/audio/transcriptions', (req: Request, res: Response, next) => {
  // Auth before the multipart body is parsed: an unauthenticated caller's
  // upload is never buffered.
  if (!requireInferenceAuth(req, res)) return;
  transcriptionUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: {
            message: `Audio file too large: the maximum upload size is ${MAX_TRANSCRIPTION_BYTES / (1024 * 1024)} MB.`,
            type: 'invalid_request_error',
            code: 'file_too_large',
          },
        });
        return;
      }
      transcriptionBadRequest(res, 'Malformed multipart/form-data upload.');
      return;
    }
    next();
  });
}, async (req: Request, res: Response) => {
  const file = req.file;
  if (!file || !file.buffer?.length) {
    transcriptionBadRequest(res, 'Invalid request: `file` is required (multipart/form-data audio upload).');
    return;
  }
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!model) {
    transcriptionBadRequest(res, "Invalid request: `model` is required (use 'whisper-1' or 'auto' to let the router decide).");
    return;
  }
  const rawFormat = typeof req.body?.response_format === 'string' ? req.body.response_format.trim() : '';
  const responseFormat = rawFormat || 'json';
  if (!TRANSCRIPTION_FORMATS.has(responseFormat)) {
    transcriptionBadRequest(res, `Invalid response_format '${responseFormat}'. Supported: json, text, verbose_json, vtt.`);
    return;
  }
  if (responseFormat === 'srt') {
    transcriptionBadRequest(
      res,
      "response_format 'srt' is not supported: no configured provider produces srt natively. Use json, text, verbose_json, or vtt.",
      'unsupported_format',
    );
    return;
  }
  let temperature: number | undefined;
  if (req.body?.temperature !== undefined && req.body.temperature !== '') {
    temperature = Number(req.body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
      transcriptionBadRequest(res, 'Invalid temperature: must be a number between 0 and 1.');
      return;
    }
  }
  const language = typeof req.body?.language === 'string' && req.body.language.trim() ? req.body.language.trim() : undefined;
  const prompt = typeof req.body?.prompt === 'string' && req.body.prompt ? req.body.prompt : undefined;

  try {
    const result = await runTranscription(model, {
      file: file.buffer,
      filename: file.originalname || 'audio',
      mimeType: file.mimetype,
      language,
      prompt,
      temperature,
      responseFormat,
    });
    res.setHeader('X-Provider', safeHeaderValue(result.platform));
    res.setHeader('X-Model', safeHeaderValue(result.modelId));
    if (responseFormat === 'text') {
      res.type('text/plain').send(result.text);
      return;
    }
    if (responseFormat === 'vtt') {
      res.type('text/vtt').send(result.vtt ?? '');
      return;
    }
    if (responseFormat === 'verbose_json' && Array.isArray(result.segments) && result.segments.length > 0) {
      res.json({
        task: 'transcribe',
        language: result.language ?? null,
        duration: result.duration ?? null,
        text: result.text,
        segments: result.segments,
      });
      return;
    }
    res.json({ text: result.text });
  } catch (err) {
    const status = err instanceof MediaError ? err.status : 502;
    const code = err instanceof MediaError ? inferenceBudgetCode(err, res) : {};
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({ error: { message: `transcription error: ${errorMessage(err, 'unknown')}`, type: mediaErrorType(status), ...code } });
  }
});
