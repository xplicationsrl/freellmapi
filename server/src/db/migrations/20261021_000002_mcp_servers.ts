// Migration: MCP client server configuration
// Created: 2026-10-21
//
// DOWN: reversible
//
// External MCP servers the Playground can call tools on. One row per server,
// owned by a dashboard account. Credentials (HTTP headers, stdio environment)
// are stored AES-256-GCM encrypted in secrets_*; they are separate from the
// upstream provider keys and never leave the server.
//
//  - transport 'http' = Streamable HTTP at url; 'stdio' = a local process
//    (command + args_json). Running a stdio server runs software on the host,
//    so it is only usable when the operator enables it explicitly.
//  - allow_private lets an administrator point an http server at a loopback or
//    private address; off by default (SSRF guard).
//  - tool_policy_json maps a server tool name to 'allow' | 'ask' | 'deny';
//    anything unlisted uses default_policy.
//  - last_error / last_connected_at_ms feed the Integrations status column.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      transport TEXT NOT NULL CHECK (transport IN ('http', 'stdio')),
      url TEXT,
      command TEXT,
      args_json TEXT NOT NULL DEFAULT '[]',
      secrets_encrypted TEXT,
      secrets_iv TEXT,
      secrets_auth_tag TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      allow_private INTEGER NOT NULL DEFAULT 0,
      default_policy TEXT NOT NULL DEFAULT 'ask'
        CHECK (default_policy IN ('allow', 'ask', 'deny')),
      tool_policy_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      last_connected_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE (user_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_servers_user
      ON mcp_servers(user_id, enabled);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_mcp_servers_user;
    DROP TABLE IF EXISTS mcp_servers;
  `);
}
