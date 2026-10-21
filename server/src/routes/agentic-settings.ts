import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { assessProviderUrl } from '../lib/url-guard.js';
import { getAgenticSettings, updateAgenticSettings } from '../services/agentic-config.js';
import { getSandboxExecutor, registerSandboxTool } from '../services/sandbox/executor.js';

// Operator settings for the agent features (Settings > Agent in the dashboard),
// mounted under /api/agentic-settings behind the dashboard session gate. The
// sandbox token is write-only: reads only say whether one is stored.

export const agenticSettingsRouter = Router();

agenticSettingsRouter.get('/', (_req: Request, res: Response) => {
  res.json(getAgenticSettings());
});

const patchSchema = z.object({
  sandboxUrl: z.string().trim().max(500).optional(),
  sandboxToken: z.string().max(500).optional(),
  allowStdio: z.boolean().optional(),
  sandboxAutoApprove: z.boolean().optional(),
}).strict();

agenticSettingsRouter.put('/', async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid settings' } });
    return;
  }
  const { sandboxUrl } = parsed.data;
  if (sandboxUrl) {
    let url: URL;
    try { url = new URL(sandboxUrl); } catch {
      res.status(400).json({ error: { message: 'The sandbox worker URL is not valid' } });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      res.status(400).json({ error: { message: 'The sandbox worker URL must be http or https' } });
      return;
    }
    // The worker normally runs beside this server, so private addresses are
    // fine; only cloud-metadata style targets are refused.
    const verdict = await assessProviderUrl(sandboxUrl, { blockPrivate: false });
    if (!verdict.allowed) {
      res.status(400).json({ error: { message: `URL blocked: ${verdict.reason}` } });
      return;
    }
  }
  updateAgenticSettings(parsed.data);
  registerSandboxTool();
  res.json(getAgenticSettings());
});

// Ask the configured worker whether it is up and has its runtime image.
agenticSettingsRouter.post('/sandbox/test', async (_req: Request, res: Response) => {
  const executor = getSandboxExecutor();
  if (!executor) {
    res.json({ ok: false, error: 'Enter the worker URL and token first' });
    return;
  }
  res.json(await executor.health());
});
