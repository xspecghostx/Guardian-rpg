# Guardian RPG Cloudflare Runtime — Restricted Credential Version

This version DOES NOT require the Supabase service-role key in Cloudflare.

Upload these four files directly to the root of the existing GitHub repository, replacing the previous versions:

- index.js
- package.json
- wrangler.jsonc
- README.md

Cloudflare build settings:
- Root directory: /
- Build command: blank
- Deploy command: npx wrangler deploy

After the GitHub-triggered deployment completes, add these two Cloudflare Worker secrets:
- RPG_DB_TOKEN — campaign-scoped bridge credential
- RPG_API_TOKEN — protects the public Worker API

Do not create SUPABASE_SERVICE_ROLE_KEY in Cloudflare.

The Supabase Edge Function `rpg-runtime-bridge` is already deployed and performs server-side Supabase access. The Cloudflare Worker only receives the campaign-scoped RPG_DB_TOKEN.
