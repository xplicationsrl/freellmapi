// Feature flags for the agentic features: MCP client, code sandbox, knowledge
// base and voice. All default OFF so an unconfigured install behaves exactly as
// before. Precedence mirrors the response cache and guardrails: the
// settings-table value wins when present (runtime-tunable, no restart), then
// the env var, then the default.

import { getSetting } from '../db/index.js';

export type FeatureName = 'mcp_client' | 'sandbox' | 'knowledge' | 'voice';

const ENV_NAMES: Record<FeatureName, string> = {
  mcp_client: 'FEATURE_MCP_CLIENT',
  sandbox: 'FEATURE_SANDBOX',
  knowledge: 'FEATURE_KNOWLEDGE',
  voice: 'FEATURE_VOICE',
};

function parseFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no' || v === '') return false;
  return undefined;
}

export function settingKeyForFeature(name: FeatureName): string {
  return `feature_${name}`;
}

export function isFeatureEnabled(name: FeatureName): boolean {
  let stored: string | undefined;
  try {
    stored = getSetting(settingKeyForFeature(name));
  } catch {
    stored = undefined;
  }
  const fromSetting = parseFlag(stored);
  if (fromSetting !== undefined) return fromSetting;
  return parseFlag(process.env[ENV_NAMES[name]]) ?? false;
}

export function featureStates(): Record<FeatureName, boolean> {
  return {
    mcp_client: isFeatureEnabled('mcp_client'),
    sandbox: isFeatureEnabled('sandbox'),
    knowledge: isFeatureEnabled('knowledge'),
    voice: isFeatureEnabled('voice'),
  };
}
