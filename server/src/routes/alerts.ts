import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { listPendingAlerts, markAlertsNotified } from '../services/usage-alerts.js';

export const alertsRouter = Router();

alertsRouter.get('/', (_req: Request, res: Response) => {
  res.json({ alerts: listPendingAlerts() });
});

const ackSchema = z.object({ ids: z.array(z.number().int()).max(100) }).strict();

alertsRouter.post('/ack', (req: Request, res: Response) => {
  const parsed = ackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'ids must be an array of integers', type: 'invalid_request_error' } });
    return;
  }
  markAlertsNotified(parsed.data.ids);
  res.json({ ok: true });
});
