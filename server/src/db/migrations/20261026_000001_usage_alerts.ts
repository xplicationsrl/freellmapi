// Migration: usage alerts
// Created: 2026-10-26
//
// DOWN: reversible
//
//  - usage_alerts: one row per raised alert. dedupe_key is unique so a
//    condition that stays true (key at 80% of its cap, key still invalid)
//    raises exactly once per period instead of on every health pass.
//    notified_at_ms is set once the dashboard has shown it.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
      key_id INTEGER,
      message TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL,
      notified_at_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_usage_alerts_pending
      ON usage_alerts(notified_at_ms, created_at_ms);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_usage_alerts_pending;
    DROP TABLE IF EXISTS usage_alerts;
  `);
}
