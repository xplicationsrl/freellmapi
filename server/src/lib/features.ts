// Availability of the agentic features: MCP client, code sandbox, knowledge
// base and voice. All are ON by default; a feature that still needs setup (the
// sandbox needs a worker) simply offers nothing until it is configured. An
// operator can still switch one off through the settings table or an env var
// (precedence: settings value, then env var, then on).

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
  return parseFlag(process.env[ENV_NAMES[name]]) ?? true;
}

export function featureStates(): Record<FeatureName, boolean> {
  return {
    mcp_client: isFeatureEnabled('mcp_client'),
    sandbox: isFeatureEnabled('sandbox'),
    knowledge: isFeatureEnabled('knowledge'),
    voice: isFeatureEnabled('voice'),
  };
}
