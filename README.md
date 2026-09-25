# Guardian RPG Worker + MCP

This package upgrades the existing `guardian-rpg` Cloudflare Worker without embedding either private token.

## Existing secrets that must remain configured in Cloudflare

- `RPG_API_TOKEN`
- `RPG_DB_TOKEN`

Do not put either value in GitHub or this package.

## Added endpoints

- `GET /health`
- `GET /campaign/<slug>/state`
- `GET /campaign/<slug>/context`
- `POST /campaign/<slug>/refresh`
- `POST /campaign/<slug>/apply`
- `POST /campaign/<slug>/patch`
- `POST /mcp` (MCP Streamable HTTP JSON-RPC)
- `GET /.well-known/oauth-protected-resource`
- `GET /oauth/consent`

## MCP tools

- `rpg_get_context`
- `rpg_get_named_rule`
- `rpg_get_rule_path`
- `rpg_get_full_state`
- `rpg_patch_state`

The MCP endpoint also accepts the existing `RPG_API_TOKEN` for MCP Inspector/local testing. ChatGPT itself should connect through OAuth 2.1, not a custom API key.

## Supabase OAuth setup required for ChatGPT

In Supabase Dashboard:

1. Authentication -> OAuth Server: enable OAuth 2.1 server.
2. Enable dynamic client registration.
3. Authentication -> URL Configuration: set Site URL to:
   `https://guardian-rpg.mitchdavisgmail.workers.dev`
4. OAuth Server Authorization Path: `/oauth/consent`
5. Add `https://guardian-rpg.mitchdavisgmail.workers.dev/**` to Auth Redirect URLs so magic-link login can return to the consent page.

The database already contains an RLS-protected `rpg_mcp_authorized_users` allowlist populated with the project's sole existing Auth user. New signups are not authorized automatically.

## ChatGPT connection

Use this MCP URL:

`https://guardian-rpg.mitchdavisgmail.workers.dev/mcp`

After deployment, connect it from ChatGPT Developer Mode / Plugins. ChatGPT will discover Supabase OAuth from the Worker and open the Guardian consent page.

## Post-deploy smoke test

With `$token` already set in PowerShell, run `test.ps1`. It checks health, compact context, MCP initialize/tools, and performs one controlled infrastructure-only `/patch` write without advancing the RPG world clock.
