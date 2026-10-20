// Row shapes shared by more than one module. Each mirrors a table as `SELECT *`
// returns it; they document the columns code reads and are not checked against
// SQLite. A module that selects only a few columns declares its own narrow type.

import type { Platform } from '@freellmapi/shared/types.js';
import type { EncryptedProxyColumns } from '../lib/key-proxy.js';

/** An `api_keys` row: the encrypted credential, its proxy columns and its health. */
export interface ApiKeyRow extends EncryptedProxyColumns {
  id: number;
  platform: Platform;
  label: string | null;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  base_url: string | null;
  group_label: string | null;
  model_scope_json: string | null;
  last_healthy_at: string | null;
  last_health_error: string | null;
  last_checked_at: string | null;
  created_at: string;
}
