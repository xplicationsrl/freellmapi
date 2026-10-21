// Start-up and shutdown housekeeping for conversation runs: mark runs left
// 'running' by a crash or restart as failed (their in-flight tool calls become
// 'uncertain'), and purge expired artifacts on a timer.

import { isFeatureEnabled } from '../../lib/features.js';
import { resumeIngestion } from '../knowledge/ingest.js';
import { connectAllEnabled, disconnectAll } from '../mcp-client/manager.js';
import { purgeExpiredArtifacts } from './artifact-store.js';
import { abortAllRuns } from './orchestrator.js';
import { failInterruptedRuns } from './run-store.js';

const PURGE_INTERVAL_MS = 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export function startAgenticRuntime(): void {
  try {
    const n = failInterruptedRuns();
    if (n > 0) console.log(`[runs] marked ${n} interrupted run(s) as failed`);
  } catch (error) {
    console.error('[runs] could not recover interrupted runs:', error instanceof Error ? error.message : error);
  }
  const purge = () => {
    try {
      purgeExpiredArtifacts();
    } catch (error) {
      console.error('[runs] artifact purge failed:', error instanceof Error ? error.message : error);
    }
  };
  purge();
  if (isFeatureEnabled('mcp_client')) {
    // Background: a slow or dead server must not delay start-up.
    void connectAllEnabled().catch(error => {
      console.error('[mcp] start-up connect failed:', error instanceof Error ? error.message : error);
    });
  }
  if (isFeatureEnabled('knowledge')) resumeIngestion();
  if (!timer) {
    timer = setInterval(purge, PURGE_INTERVAL_MS);
    timer.unref?.();
  }
}

export function stopAgenticRuntime(): void {
  abortAllRuns();
  void disconnectAll().catch(() => undefined);
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
