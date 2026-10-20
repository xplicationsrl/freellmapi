import type { Request, Response } from 'express';
import { resolveAuth, type ResolvedAuth } from './system-prompt.js';

// Shared auth gate for the /v1 inference endpoints (#411): accepts the unified
// key (default behavior, no enforced prompt) or an enabled client-profile key
// (which may carry a server-enforced system prompt). Profile keys are ONLY
// valid here — never on the /api dashboard surface. Writes the 401 itself so
// call sites can simply bail on null.
export function requireInferenceAuth(req: Request, res: Response): ResolvedAuth | null {
  const auth = resolveAuth(extractApiToken(req));
  if (!auth) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return null;
  }
  return auth;
}

// Extract the unified API key from an incoming request. Accepts both the
// OpenAI Bearer, Anthropic x-api-key, and Gemini x-goog-api-key headers.
// Query credentials remain scoped to the Gemini router.
export function extractApiToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;

  const apiKeyHeader = req.headers['x-api-key'];
  const xApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const trimmed = xApiKey?.trim();
  if (trimmed) return trimmed;
  const googleHeader = req.headers['x-goog-api-key'];
  const googleKey = Array.isArray(googleHeader) ? googleHeader[0] : googleHeader;
  return googleKey?.trim() || undefined;
}
