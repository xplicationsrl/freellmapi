import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { FUSION_MODEL_ID } from '../services/fusion.js';
import { supportedParametersForPlatforms } from '../lib/sampling-params.js';
import { buildModelListing, type NormalizedModel } from '../services/model-listing.js';
import { claudeFamilyDiscoveryEntries } from '../services/anthropic-map.js';
import { requireInferenceAuth } from '../lib/inference-auth.js';
import { AUTO_MODEL_ID } from '../lib/auto-model.js';

export const modelsProxyRouter = Router();

// OpenAI-compatible /models endpoint (used by Hermes for metadata) 
// shows API models which is linked by the user
modelsProxyRouter.get('/models', (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;

  // By default we return the WHOLE catalog (one row per model id), each tagged
  // with whether it is currently usable, so a client can see everything and know
  // what's connected vs. disabled/keyless (#242). `?available=true` (aliases
  // `?connected=true`, `?ready=true`) narrows the list to only models that can
  // serve a request right now — the previous default behavior. The `ready`
  // alias is the machine-readable filter a meta-gateway uses (#433) to ask
  // "which models can this instance actually serve now". `available` is computed as
  // "enabled AND an enabled key can serve it"; dedup prefers an available
  // instance of a model id over a disabled/keyless one.
  // Shared catalog listing (one source of truth for the OpenAI and Anthropic
  // /v1/models endpoints — see services/model-listing.ts). `autoContextWindow`
  // is the honest ceiling for the virtual "auto" model: the largest context
  // window among models that can serve a request right now. Advertising null
  // makes OpenAI-compatible clients (opencode, Continue) fall back to their own
  // conservative default and truncate long inputs before they reach us (#282).
  const { models: allListed, autoContextWindow } = buildModelListing();

  const q = String(req.query.available ?? req.query.connected ?? req.query.ready ?? '').toLowerCase();
  const onlyAvailable = q === '1' || q === 'true' || q === 'yes';
  const listed = onlyAvailable ? allListed.filter(m => m.available === 1) : allListed;

  // Named fallback chains (#960/#895): every user-defined profile is exposed
  // as an `auto:<name>` model so a client can pick a specific fallback chain
  // per request (auto:my-group) instead of only the active one. Available iff
  // at least one model in that profile's chain can serve a request right now.
  const profileRows = getDb().prepare(`
    SELECT p.id, p.name,
           EXISTS (
             SELECT 1
             FROM profile_models pm
             JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
             WHERE pm.profile_id = p.id AND pm.enabled = 1
               AND EXISTS (
                 SELECT 1 FROM api_keys k
                 WHERE k.platform = m.platform AND k.enabled = 1
                   AND (m.key_id IS NULL OR k.id = m.key_id)
               )
           ) AS usable,
           (SELECT MAX(m2.context_window)
            FROM profile_models pm2
            JOIN models m2 ON m2.id = pm2.model_db_id AND m2.enabled = 1
            WHERE pm2.profile_id = p.id AND pm2.enabled = 1) AS max_ctx
    FROM profiles p
    WHERE p.type = 'custom'
    ORDER BY p.sort_order, p.id
  `).all() as { id: number; name: string; usable: number; max_ctx: number | null }[];

  // Claude-family discovery entries (#880). The Anthropic-shaped GET /v1/models
  // in routes/anthropic.ts already lists one id per Claude family so clients
  // that only accept Claude-looking ids can discover anything at all — but that
  // handler only answers when the caller sends an `anthropic-version` header.
  // Claude Desktop's gateway picker fetches this path WITHOUT that header, so
  // it fell through to the OpenAI-shaped listing below and still saw zero
  // Claude-shaped ids. Emit the same entries here, from the same builder, so
  // both shapes agree on what the gateway will serve. Listed only when
  // something can actually serve them, and never when the id would collide
  // with a real catalog row.
  const listedIds = new Set(listed.map(m => m.id));
  const claudeFamilyEntries = allListed.some(m => m.available === 1)
    ? claudeFamilyDiscoveryEntries()
      .filter(a => !listedIds.has(a.id))
      .map(a => ({
        id: a.id,
        object: 'model' as const,
        created: 0,
        owned_by: 'freellmapi',
        name: a.displayName,
        context_window: autoContextWindow,
        context_length: autoContextWindow,
        available: true,
        unavailable_reason: null,
      }))
    : [];

  // Machine-readable execution filter: `?execution_status=ready` narrows to
  // models a request can actually serve RIGHT NOW (a key that is not scoped
  // away, cooling down or out of window). `ready` implies available;
  // `needsKey`/`exhausted` select the rest. Matched case-insensitively because
  // the value itself is camelCase; an unrecognised value filters nothing, the
  // same way an unrecognised `?available=` does. Like `?available=`, this
  // narrows only the catalog rows: `auto`, `fusion` and the named chains are
  // router entries, not models with keys of their own.
  const esValues: Record<string, NormalizedModel['executionStatus']> = {
    ready: 'ready', needskey: 'needsKey', exhausted: 'exhausted',
  };
  const es = esValues[String(req.query.execution_status ?? '').toLowerCase()];
  const esFiltered = es ? listed.filter(m => m.executionStatus === es) : listed;

  res.json({
    object: 'list',
    data: [
      {
        id: AUTO_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: 'Auto (router picks the best available model)',
        context_window: autoContextWindow,
        // `context_length` is OpenRouter's field name and the one most
        // OpenAI-compatible clients read; emit both so whichever a client
        // looks for is populated. Additive — clients ignore unknown fields.
        context_length: autoContextWindow,
        available: true,
        unavailable_reason: null,
      },
      {
        id: FUSION_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: 'Fusion (panel of models answer in parallel, a judge synthesizes one answer)',
        context_window: autoContextWindow,
        context_length: autoContextWindow,
        // Available whenever auto is — fusion needs at least one routable model.
        available: autoContextWindow != null,
        unavailable_reason: autoContextWindow != null ? null : 'no_models',
      },
      ...claudeFamilyEntries,
      ...profileRows.map(p => ({
        id: `auto:${p.name.toLowerCase()}`,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: `Auto: ${p.name} (named fallback chain)`,
        context_window: p.max_ctx,
        context_length: p.max_ctx,
        available: p.usable === 1,
        unavailable_reason: p.usable === 1 ? null : 'no_models',
      })),
      ...esFiltered.map(m => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: m.ownedBy,
        name: m.name,
        context_window: m.contextWindow,
        context_length: m.contextWindow,
        // Non-standard but additive: OpenAI clients ignore unknown fields.
        available: m.available === 1,
        unavailable_reason: m.available === 1 ? null : (m.enabled === 1 ? 'no_key' : 'disabled'),
        // Machine-readable dynamic status: 'ready' | 'needsKey' | 'exhausted'
        // (see services/model-listing.ts). Agents can filter with
        // ?execution_status=ready and route around exhausted models.
        execution_status: m.executionStatus,
        // OpenRouter's field name; agents use it to pick knobs per model. For
        // a unify group this is the intersection over member platforms — a
        // param is only advertised when every platform the router might pick
        // honors it.
        supported_parameters: supportedParametersForPlatforms(m.platforms, { tools: m.supportsTools }),
      })),
    ],
  });
});
