import { DurableObject } from "cloudflare:workers";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function unauthorized() {
  return json({ ok: false, error: "unauthorized" }, 401);
}

function bearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

async function bridge(env, body) {
  if (!env.RPG_DB_TOKEN) throw new Error("RPG_DB_TOKEN is not configured");

  const response = await fetch(`${env.SUPABASE_URL}/functions/v1/rpg-runtime-bridge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rpg-token": env.RPG_DB_TOKEN,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`RPG bridge failed (${response.status}): ${text}`);
  }
  return payload;
}

export class CampaignRuntime extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS runtime_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  getCached(key) {
    const row = this.ctx.storage.sql
      .exec("SELECT value, updated_at FROM runtime_cache WHERE key = ?", key)
      .toArray()[0];
    if (!row) return null;
    return { value: JSON.parse(row.value), updatedAt: Number(row.updated_at) };
  }

  setCached(key, value) {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO runtime_cache(key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      now,
    );
    return now;
  }

  async loadSnapshot(slug, force = false) {
    const cacheKey = `snapshot:${slug}`;
    const cached = this.getCached(cacheKey);
    if (!force && cached) return cached.value;

    const snapshot = await bridge(this.env, { op: "snapshot", slug });
    this.setCached(cacheKey, snapshot);
    return snapshot;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug") || this.env.DEFAULT_CAMPAIGN_SLUG;

    if (url.pathname === "/health") {
      return json({ ok: true, durable_object: true, region_hint: "oc" });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const snapshot = await this.loadSnapshot(slug, false);
      return json({ ok: true, snapshot });
    }

    if (request.method === "POST" && url.pathname === "/refresh") {
      const snapshot = await this.loadSnapshot(slug, true);
      return json({ ok: true, snapshot });
    }

    if (request.method === "POST" && url.pathname === "/apply") {
      const body = await request.json();
      const cached = await this.loadSnapshot(slug, false);
      const expected = body.expected_state_version ?? cached?.campaign?.state_version;

      if (expected === undefined || expected === null) {
        return json({ ok: false, error: "missing_state_version" }, 400);
      }

      const result = await bridge(this.env, {
        op: "apply",
        slug,
        expected_state_version: expected,
        rules_config: body.rules_config ?? null,
        clock: body.clock ?? null,
        actor_updates: body.actor_updates ?? [],
        project_updates: body.project_updates ?? [],
        combatant_updates: body.combatant_updates ?? [],
      });

      if (result?.snapshot) {
        this.setCached(`snapshot:${slug}`, result.snapshot);
      }

      const status = result?.ok === false && result?.error === "state_version_conflict" ? 409 : 200;
      return json(result, status);
    }

    return json({ ok: false, error: "not_found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "rpg-campaign-runtime",
        worker_placement: "aws:ap-southeast-2 (Sydney proximity)",
        durable_object_location_hint: "oc (Oceania, best effort)",
        db_bridge_configured: Boolean(env.RPG_DB_TOKEN),
        api_auth_configured: Boolean(env.RPG_API_TOKEN),
      });
    }

    if (!env.RPG_API_TOKEN || bearer(request) !== env.RPG_API_TOKEN) {
      return unauthorized();
    }

    const match = url.pathname.match(/^\/campaign\/([^/]+)\/(state|refresh|apply)$/);
    if (!match) {
      return json({ ok: false, error: "not_found" }, 404);
    }

    const slug = decodeURIComponent(match[1]);
    const operation = match[2];
    const id = env.CAMPAIGN_RUNTIME.idFromName(slug);
    const stub = env.CAMPAIGN_RUNTIME.get(id, { locationHint: "oc" });

    const internalUrl = new URL(`https://durable.internal/${operation}`);
    internalUrl.searchParams.set("slug", slug);

    const proxied = new Request(internalUrl, request);
    return stub.fetch(proxied);
  },
};
