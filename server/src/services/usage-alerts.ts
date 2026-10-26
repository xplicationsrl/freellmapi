/**
 * Usage alerts: raised after each key health pass for conditions an operator
 * would otherwise only notice by opening the dashboard.
 *
 *  - key_quota: a key's monthly request/token cap (key-budget.ts) crossed
 *    ALERT_THRESHOLD_PCT, or reached 100%.
 *  - key_down: a key failed validation (invalid / auto-disabled by the health checker).
 *
 * Each condition is deduped per period (month for quota, status for down) via
 * usage_alerts.dedupe_key, so it raises once, not every pass. The dashboard
 * polls pending alerts, toasts them, and marks them notified.
 */
import { getDb } from '../db/index.js';
import { getMonthlyUsage } from './key-budget.js';

const ALERT_THRESHOLD_PCT = 80;

export interface UsageAlert {
  id: number;
  kind: string;
  severity: 'info' | 'warning' | 'error';
  keyId: number | null;
  message: string;
  createdAtMs: number;
}

interface KeyRow {
  id: number;
  platform: string;
  label: string | null;
  status: string;
  enabled: number;
  monthly_request_cap: number;
  monthly_token_cap: number;
}

function raise(
  kind: string,
  severity: UsageAlert['severity'],
  keyId: number,
  message: string,
  dedupeKey: string,
): void {
  getDb().prepare(`
    INSERT INTO usage_alerts (kind, severity, key_id, message, dedupe_key, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `).run(kind, severity, keyId, message, dedupeKey, Date.now());
}

export function evaluateUsageAlerts(now = Date.now()): void {
  const month = new Date(now).toISOString().slice(0, 7);
  const keys = getDb().prepare(`
    SELECT id, platform, label, status, enabled, monthly_request_cap, monthly_token_cap
    FROM api_keys
  `).all() as KeyRow[];

  for (const key of keys) {
    const name = `${key.label || 'Key'} (${key.platform})`;

    // status stays 'invalid' after the health checker auto-disables a key, so
    // this also covers auto-disable without alerting on keys the operator
    // switched off by hand.
    if (key.status === 'invalid') {
      raise('key_down', 'error', key.id, `${name} failed validation and is not serving requests.`, `key_down:${key.id}`);
    }

    if (key.monthly_request_cap > 0 || key.monthly_token_cap > 0) {
      const usage = getMonthlyUsage(key.id, now);
      const pcts = [
        key.monthly_request_cap > 0 ? (usage.requests / key.monthly_request_cap) * 100 : 0,
        key.monthly_token_cap > 0 ? (usage.tokens / key.monthly_token_cap) * 100 : 0,
      ];
      const pct = Math.max(...pcts);
      if (pct >= 100) {
        raise('key_quota', 'error', key.id, `${name} hit its monthly cap and is rejecting requests until next month.`, `key_quota:${key.id}:${month}:100`);
      } else if (pct >= ALERT_THRESHOLD_PCT) {
        raise('key_quota', 'warning', key.id, `${name} used ${Math.floor(pct)}% of its monthly cap.`, `key_quota:${key.id}:${month}:${ALERT_THRESHOLD_PCT}`);
      }
    }
  }
}

/** Alerts the dashboard has not shown yet, oldest first. */
export function listPendingAlerts(): UsageAlert[] {
  const rows = getDb().prepare(`
    SELECT id, kind, severity, key_id, message, created_at_ms
    FROM usage_alerts WHERE notified_at_ms IS NULL
    ORDER BY created_at_ms ASC LIMIT 20
  `).all() as Array<{ id: number; kind: string; severity: UsageAlert['severity']; key_id: number | null; message: string; created_at_ms: number }>;
  return rows.map(r => ({
    id: r.id, kind: r.kind, severity: r.severity, keyId: r.key_id, message: r.message, createdAtMs: r.created_at_ms,
  }));
}

export function markAlertsNotified(ids: number[]): void {
  if (ids.length === 0) return;
  const stmt = getDb().prepare('UPDATE usage_alerts SET notified_at_ms = ? WHERE id = ? AND notified_at_ms IS NULL');
  const now = Date.now();
  getDb().transaction(() => { for (const id of ids) stmt.run(now, id); })();
}
