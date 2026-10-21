// Operator settings for the agentic features, edited in the dashboard
// (Settings > Agent) instead of environment variables. The settings-table value
// wins; the matching env var is the fallback so existing deployments that set
// them keep working. The sandbox worker token is stored encrypted.

import { getSetting, setSetting } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';

const KEYS = {
  sandboxUrl: 'agentic_sandbox_url',
  sandboxToken: 'agentic_sandbox_token',
  allowStdio: 'agentic_allow_stdio',
  sandboxAutoApprove: 'agentic_sandbox_auto_approve',
} as const;

function flag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no', ''].includes(v)) return false;
  return undefined;
}

function read(key: string): string | undefined {
  try { return getSetting(key); } catch { return undefined; }
}

export function sandboxWorkerUrl(): string | null {
  const url = (read(KEYS.sandboxUrl) ?? process.env.SANDBOX_WORKER_URL ?? '').trim();
  return url ? url.replace(/\/+$/, '') : null;
}

export function sandboxWorkerToken(): string | null {
  const stored = read(KEYS.sandboxToken);
  if (stored) {
    try {
      const { encrypted, iv, authTag } = JSON.parse(stored) as { encrypted: string; iv: string; authTag: string };
      return decrypt(encrypted, iv, authTag);
    } catch {
      return null;
    }
  }
  return process.env.SANDBOX_WORKER_TOKEN?.trim() || null;
}

export function isStdioAllowed(): boolean {
  return flag(read(KEYS.allowStdio)) ?? flag(process.env.MCP_ALLOW_STDIO) ?? false;
}

export function sandboxRequiresApproval(): boolean {
  return !(flag(read(KEYS.sandboxAutoApprove)) ?? flag(process.env.SANDBOX_AUTO_APPROVE) ?? false);
}

export interface AgenticSettingsView {
  sandboxUrl: string;
  hasSandboxToken: boolean;
  allowStdio: boolean;
  sandboxAutoApprove: boolean;
}

export function getAgenticSettings(): AgenticSettingsView {
  return {
    sandboxUrl: sandboxWorkerUrl() ?? '',
    hasSandboxToken: sandboxWorkerToken() !== null,
    allowStdio: isStdioAllowed(),
    sandboxAutoApprove: !sandboxRequiresApproval(),
  };
}

export interface AgenticSettingsPatch {
  sandboxUrl?: string;
  /** Omitted keeps the stored token; an empty string clears it. */
  sandboxToken?: string;
  allowStdio?: boolean;
  sandboxAutoApprove?: boolean;
}

export function updateAgenticSettings(patch: AgenticSettingsPatch): void {
  if (patch.sandboxUrl !== undefined) setSetting(KEYS.sandboxUrl, patch.sandboxUrl.trim());
  if (patch.sandboxToken !== undefined) {
    setSetting(KEYS.sandboxToken, patch.sandboxToken ? JSON.stringify(encrypt(patch.sandboxToken)) : '');
  }
  if (patch.allowStdio !== undefined) setSetting(KEYS.allowStdio, patch.allowStdio ? '1' : '0');
  if (patch.sandboxAutoApprove !== undefined) setSetting(KEYS.sandboxAutoApprove, patch.sandboxAutoApprove ? '1' : '0');
}
