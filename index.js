import { DurableObject } from "cloudflare:workers";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_SERVER_VERSION = "1.0.0";
const DEFAULT_CACHE_TTL_MS = 5000;

function corsHeaders(request) {
  const requestedHeaders =
    request.headers.get("access-control-request-headers") ||
    "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id";

  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": requestedHeaders,
    "access-control-expose-headers": "MCP-Session-Id",
    "access-control-max-age": "86400",
  };
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function bearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let value = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (value.length % 4) value += "=";
    return JSON.parse(atob(value));
  } catch {
    return null;
  }
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
    const error = new Error(`RPG bridge failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function compactSnapshot(snapshot) {
  const campaign = snapshot?.campaign || {};
  const rules = campaign.rules_config || {};
  const runtime = rules.runtime_state || {};
  const selectedPower = rules.power_packages?.selected;
  const selectedPowerDefinition = selectedPower
    ? rules.power_packages?.[selectedPower]
    : null;

  const prunedRuntime = {};
  for (const [key, value] of Object.entries(runtime)) {
    // Historical strategic snapshots are useful for audits but are noisy for ordinary turns.
    if (key.startsWith("strategic_activity_snapshot_")) continue;
    prunedRuntime[key] = value;
  }

  const playerActor = (snapshot?.actors || []).find((a) => a.actor_key === "player_1") || null;
  const playerCombatant = (snapshot?.combatants || []).find((c) => c.kind === "player") || null;

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      slug: campaign.slug,
      status: campaign.status,
      state_version: campaign.state_version,
      rules_version: campaign.rules_version,
      world_day: campaign.world_day,
      owner_configured: Boolean(campaign.owner_user_id),
    },
    clock: snapshot?.clock || null,
    player: {
      actor: playerActor,
      combatant: playerCombatant,
      runtime: runtime.player || null,
      xp_ledger: runtime.xp_ledger || [],
    },
    rules: {
      player: rules.player || null,
      mana_system: rules.mana_system || null,
      natural_recovery: rules.natural_recovery || null,
      progression_system: rules.progression_system || null,
      simulation_contract: rules.simulation_contract || null,
      selected_power_key: selectedPower || null,
      selected_power: selectedPowerDefinition || null,
      strategic_simulation_rule: runtime.strategic_simulation_rule || null,
      strategic_dashboard_visibility: runtime.strategic_dashboard_visibility || null,
    },
    runtime_state: prunedRuntime,
    actors: snapshot?.actors || [],
    projects: snapshot?.projects || [],
    combatants: snapshot?.combatants || [],
    progression_settings: snapshot?.progression_settings || null,
  };
}

function getPath(root, path) {
  let value = root;
  for (const segment of path) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    value = value[segment];
  }
  return value;
}

function cacheTtl(env) {
  const parsed = Number(env.CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CACHE_TTL_MS;
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
    const fresh = cached && Date.now() - cached.updatedAt <= cacheTtl(this.env);
    if (!force && fresh) return cached.value;

    const snapshot = await bridge(this.env, { op: "snapshot", slug });
    this.setCached(cacheKey, snapshot);
    return snapshot;
  }

  async mutation(slug, op, body) {
    const cached = await this.loadSnapshot(slug, false);
    const expected = body.expected_state_version ?? cached?.campaign?.state_version;

    if (expected === undefined || expected === null) {
      return { response: json({ ok: false, error: "missing_state_version" }, 400) };
    }

    const payload = {
      op,
      slug,
      expected_state_version: expected,
      clock: body.clock ?? null,
      actor_updates: body.actor_updates ?? [],
      project_updates: body.project_updates ?? [],
      combatant_updates: body.combatant_updates ?? [],
    };

    if (op === "apply") payload.rules_config = body.rules_config ?? null;
    if (op === "patch") payload.rules_patch_ops = body.rules_patch_ops ?? [];

    const result = await bridge(this.env, payload);
    if (result?.snapshot) this.setCached(`snapshot:${slug}`, result.snapshot);

    const status = result?.ok === false && result?.error === "state_version_conflict" ? 409 : 200;
    return { result, response: json(result, status) };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug") || this.env.DEFAULT_CAMPAIGN_SLUG;

    try {
      if (url.pathname === "/health") {
        return json({ ok: true, durable_object: true, region_hint: "oc" });
      }

      if (request.method === "GET" && url.pathname === "/state") {
        const snapshot = await this.loadSnapshot(slug, false);
        return json({ ok: true, snapshot });
      }

      if (request.method === "GET" && url.pathname === "/context") {
        const snapshot = await this.loadSnapshot(slug, false);
        return json({ ok: true, context: compactSnapshot(snapshot) });
      }

      if (request.method === "POST" && url.pathname === "/refresh") {
        const snapshot = await this.loadSnapshot(slug, true);
        return json({ ok: true, snapshot });
      }

      if (request.method === "POST" && url.pathname === "/apply") {
        const body = await request.json();
        return (await this.mutation(slug, "apply", body)).response;
      }

      if (request.method === "POST" && url.pathname === "/patch") {
        const body = await request.json();
        return (await this.mutation(slug, "patch", body)).response;
      }

      return json({ ok: false, error: "not_found" }, 404);
    } catch (error) {
      return json({
        ok: false,
        error: "runtime_error",
        message: error?.message || String(error),
        bridge_status: error?.status || null,
        detail: error?.payload || null,
      }, 500);
    }
  }
}

function resourceMetadata(request, env) {
  const url = new URL(request.url);
  return {
    resource: `${url.origin}/mcp`,
    authorization_servers: [`${env.SUPABASE_URL}/auth/v1`],
    scopes_supported: ["openid", "email", "profile"],
    resource_documentation: `${url.origin}/health`,
  };
}

function mcpChallenge(request, env, status = 401, body = { error: "authorization_required" }) {
  const url = new URL(request.url);
  const metadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;
  const challenge = `Bearer resource_metadata="${metadataUrl}", scope="openid email profile"`;
  return json(body, status, { "www-authenticate": challenge });
}

async function authorizeMcp(request, env) {
  const token = bearer(request);
  if (!token) return { ok: false, response: mcpChallenge(request, env) };

  // Keep the existing API token usable for MCP Inspector / local testing.
  if (env.RPG_API_TOKEN && token === env.RPG_API_TOKEN) {
    return { ok: true, mode: "api_token" };
  }

  if (!env.SUPABASE_PUBLISHABLE_KEY) {
    return {
      ok: false,
      response: json({ error: "mcp_oauth_not_configured", detail: "SUPABASE_PUBLISHABLE_KEY is missing" }, 503),
    };
  }

  const claims = decodeJwtPayload(token);
  const userId = claims?.sub || claims?.user_id;
  const clientId = claims?.client_id;
  const expectedIssuer = `${env.SUPABASE_URL}/auth/v1`;

  if (!userId || !clientId || claims?.iss !== expectedIssuer) {
    return { ok: false, response: mcpChallenge(request, env) };
  }

  // Authorization is decided by PostgREST + RLS. We decode the user id only to
  // narrow the query; PostgREST validates the JWT before the RLS policy can return a row.
  const checkUrl = new URL(`${env.SUPABASE_URL}/rest/v1/rpg_mcp_authorized_users`);
  checkUrl.searchParams.set("select", "user_id");
  checkUrl.searchParams.set("user_id", `eq.${userId}`);
  checkUrl.searchParams.set("enabled", "eq.true");
  checkUrl.searchParams.set("limit", "1");

  const response = await fetch(checkUrl, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    return { ok: false, response: mcpChallenge(request, env) };
  }

  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1) {
    return {
      ok: false,
      response: mcpChallenge(request, env, 403, { error: "mcp_user_not_authorized" }),
    };
  }

  return { ok: true, mode: "supabase_oauth", user_id: userId, client_id: clientId };
}

function oauthConsentPage(env) {
  const supabaseUrl = JSON.stringify(env.SUPABASE_URL || "");
  const publishableKey = JSON.stringify(env.SUPABASE_PUBLISHABLE_KEY || "");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Guardian RPG authorization</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(560px, calc(100vw - 32px)); border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 14px; padding: 24px; box-sizing: border-box; }
    h1 { margin: 0 0 8px; font-size: 1.45rem; }
    p { line-height: 1.45; }
    label { display: block; margin: 12px 0 6px; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Canvas; color: CanvasText; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    button { padding: 10px 14px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); cursor: pointer; }
    .primary { font-weight: 650; }
    .muted { opacity: .72; font-size: .92rem; }
    .error { color: #c33; white-space: pre-wrap; }
    ul { padding-left: 22px; }
  </style>
</head>
<body>
<main>
  <h1>Guardian RPG</h1>
  <div id="app"><p>Loading authorization request…</p></div>
</main>
<script type="module">
  import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";

  const SUPABASE_URL = ${supabaseUrl};
  const SUPABASE_KEY = ${publishableKey};
  const app = document.getElementById("app");
  const params = new URLSearchParams(location.search);
  let authorizationId = params.get("authorization_id") || localStorage.getItem("guardian_rpg_authorization_id") || "";
  if (authorizationId) localStorage.setItem("guardian_rpg_authorization_id", authorizationId);

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    app.innerHTML = '<p class="error">OAuth UI is not configured on the Worker.</p>';
    throw new Error("Missing Supabase public config");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" }
  });

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function ensureCallbackSession() {
    const code = params.get("code");
    if (!code) return;
    const current = await supabase.auth.getSession();
    if (current.data.session) return;
    const result = await supabase.auth.exchangeCodeForSession(code);
    if (result.error) console.warn(result.error.message);
  }

  function renderLogin(message) {
    const errorHtml = message ? '<p class="error">' + esc(message) + '</p>' : '';
    app.innerHTML =
      '<p>Sign in to the Supabase account authorized for this RPG database.</p>' +
      errorHtml +
      '<label>Email</label><input id="email" type="email" autocomplete="email" />' +
      '<label>Password (optional)</label><input id="password" type="password" autocomplete="current-password" />' +
      '<div class="row">' +
        '<button id="passwordLogin" class="primary">Sign in with password</button>' +
        '<button id="magicLogin">Send magic link</button>' +
      '</div>' +
      '<p class="muted">Magic-link sign-in will not create a new account.</p>';

    document.getElementById("passwordLogin").onclick = async () => {
      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;
      const result = await supabase.auth.signInWithPassword({ email, password });
      if (result.error) return renderLogin(result.error.message);
      await renderConsent();
    };

    document.getElementById("magicLogin").onclick = async () => {
      const email = document.getElementById("email").value.trim();
      if (!email) return renderLogin("Enter your email first.");
      const redirect = new URL(location.href);
      redirect.searchParams.delete("code");
      if (authorizationId) redirect.searchParams.set("authorization_id", authorizationId);
      const result = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirect.toString(), shouldCreateUser: false }
      });
      if (result.error) return renderLogin(result.error.message);
      app.innerHTML = '<p>Sign-in link sent. Open it, then this authorization page will continue.</p>';
    };
  }

  async function renderConsent() {
    if (!authorizationId) {
      app.innerHTML = '<p class="error">Missing authorization_id. Restart the ChatGPT connection.</p>';
      return;
    }

    const userResult = await supabase.auth.getUser();
    if (!userResult.data || !userResult.data.user) return renderLogin("");

    const detailsResult = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
    const details = detailsResult.data;
    if (detailsResult.error || !details) {
      app.innerHTML = '<p class="error">' + esc(detailsResult.error ? detailsResult.error.message : "Invalid authorization request") + '</p>';
      return;
    }

    if (!("authorization_id" in details)) {
      localStorage.removeItem("guardian_rpg_authorization_id");
      location.assign(details.redirect_url);
      return;
    }

    const scopes = String(details.scope || "").split(/\\s+/).filter(Boolean);
    const scopesHtml = scopes.length
      ? '<p>Requested permissions:</p><ul>' + scopes.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul>'
      : '';

    app.innerHTML =
      '<p><strong>' + esc((details.client && details.client.name) || "ChatGPT") + '</strong> is requesting access to Guardian RPG.</p>' +
      '<p class="muted">Signed in as ' + esc(userResult.data.user.email || "authorized user") + '</p>' +
      scopesHtml +
      '<div class="row">' +
        '<button id="approve" class="primary">Approve</button>' +
        '<button id="deny">Deny</button>' +
        '<button id="signout">Sign out</button>' +
      '</div>';

    document.getElementById("approve").onclick = async () => {
      const result = await supabase.auth.oauth.approveAuthorization(authorizationId);
      if (result.error) {
        app.insertAdjacentHTML("beforeend", '<p class="error">' + esc(result.error.message) + '</p>');
        return;
      }
      localStorage.removeItem("guardian_rpg_authorization_id");
      location.assign(result.data.redirect_url);
    };

    document.getElementById("deny").onclick = async () => {
      const result = await supabase.auth.oauth.denyAuthorization(authorizationId);
      if (result.error) {
        app.insertAdjacentHTML("beforeend", '<p class="error">' + esc(result.error.message) + '</p>');
        return;
      }
      localStorage.removeItem("guardian_rpg_authorization_id");
      location.assign(result.data.redirect_url);
    };

    document.getElementById("signout").onclick = async () => {
      await supabase.auth.signOut();
      renderLogin("");
    };
  }

  await ensureCallbackSession();
  await renderConsent();
</script>
</body>
</html>`;
}

async function runtimeFetch(env, slug, operation, init = {}) {
  const id = env.CAMPAIGN_RUNTIME.idFromName(slug);
  const stub = env.CAMPAIGN_RUNTIME.get(id, { locationHint: "oc" });
  const internalUrl = new URL(`https://durable.internal/${operation}`);
  internalUrl.searchParams.set("slug", slug);
  return stub.fetch(new Request(internalUrl, init));
}

async function runtimeJson(env, slug, operation, body = null, method = "GET") {
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== null) init.body = JSON.stringify(body);
  const response = await runtimeFetch(env, slug, operation, init);
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error || `runtime_${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function mcpTools() {
  const oauth = [{ type: "oauth2", scopes: ["openid", "email", "profile"] }];
  return [
    {
      name: "rpg_get_context",
      title: "Get RPG turn context",
      description: "Get the current compact authoritative campaign context. Use this at the start of ordinary stateful RPG turns. It includes clock, state version, player state, current runtime state, strategic actors/projects, and core rules while omitting bulky historical strategic snapshots.",
      inputSchema: {
        type: "object",
        properties: { force_refresh: { type: "boolean", default: false } },
        additionalProperties: false,
      },
      securitySchemes: oauth,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "rpg_get_named_rule",
      title: "Get authoritative named RPG rule",
      description: "Look up a named preset, framework key, system spec, rule key, world-clock rule, actor template, or archetype in the authoritative Supabase RPG design database. When the user names a ruleset/preset/framework/spec/rule identifier, call this before interpreting it. A returned database match is authoritative.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["key"],
        additionalProperties: false,
      },
      securitySchemes: oauth,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "rpg_get_rule_path",
      title: "Get campaign rule path",
      description: "Read one targeted path from the campaign rules_config without returning the entire snapshot. Use for focused mechanics or runtime-state checks after rpg_get_context.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
          force_refresh: { type: "boolean", default: false },
        },
        required: ["path"],
        additionalProperties: false,
      },
      securitySchemes: oauth,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "rpg_get_full_state",
      title: "Get full RPG snapshot",
      description: "Get the complete authoritative campaign snapshot. Use only when compact context or targeted rule reads are insufficient because this result is large.",
      inputSchema: {
        type: "object",
        properties: { force_refresh: { type: "boolean", default: false } },
        additionalProperties: false,
      },
      securitySchemes: oauth,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "rpg_patch_state",
      title: "Atomically patch RPG state",
      description: "Apply one authoritative atomic state mutation with optimistic state-version checking. Use rules_patch_ops for small JSON-path updates plus clock/actor/project/combatant updates. For meaningful in-world time, include the new clock and tick every strategic project consistently. Do not advance world time for bookkeeping or infrastructure work.",
      inputSchema: {
        type: "object",
        properties: {
          expected_state_version: { type: "integer", minimum: 1 },
          rules_patch_ops: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                path: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 30 },
                value: {},
                create_missing: { type: "boolean" },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
          clock: { type: ["object", "null"] },
          actor_updates: { type: "array", maxItems: 100, items: { type: "object" } },
          project_updates: { type: "array", maxItems: 100, items: { type: "object" } },
          combatant_updates: { type: "array", maxItems: 100, items: { type: "object" } },
        },
        required: ["expected_state_version"],
        additionalProperties: false,
      },
      securitySchemes: oauth,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function toolResult(data, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

async function callMcpTool(name, args, env) {
  const slug = env.DEFAULT_CAMPAIGN_SLUG;

  if (name === "rpg_get_context") {
    const force = Boolean(args?.force_refresh);
    if (force) await runtimeJson(env, slug, "refresh", {}, "POST");
    return (await runtimeJson(env, slug, "context", null, "GET")).context;
  }

  if (name === "rpg_get_full_state") {
    const force = Boolean(args?.force_refresh);
    if (force) return (await runtimeJson(env, slug, "refresh", {}, "POST")).snapshot;
    return (await runtimeJson(env, slug, "state", null, "GET")).snapshot;
  }

  if (name === "rpg_get_rule_path") {
    const path = args?.path;
    if (!Array.isArray(path) || !path.length || path.some((x) => typeof x !== "string")) {
      throw Object.assign(new Error("path must be a non-empty string array"), { code: -32602 });
    }
    const force = Boolean(args?.force_refresh);
    const snapshot = force
      ? (await runtimeJson(env, slug, "refresh", {}, "POST")).snapshot
      : (await runtimeJson(env, slug, "state", null, "GET")).snapshot;
    const value = getPath(snapshot?.campaign?.rules_config, path);
    return { path, found: value !== undefined, value: value === undefined ? null : value };
  }

  if (name === "rpg_get_named_rule") {
    const key = typeof args?.key === "string" ? args.key.trim() : "";
    if (!key) throw Object.assign(new Error("key is required"), { code: -32602 });
    return bridge(env, { op: "named_rule", slug, key });
  }

  if (name === "rpg_patch_state") {
    if (!Number.isInteger(args?.expected_state_version) || args.expected_state_version < 1) {
      throw Object.assign(new Error("expected_state_version is required"), { code: -32602 });
    }
    const rulesPatchOps = Array.isArray(args.rules_patch_ops) ? args.rules_patch_ops : [];
    if (rulesPatchOps.some((op) => op && op.delete === true)) {
      throw Object.assign(new Error("MCP patch tool does not permit delete operations"), { code: -32602 });
    }
    const payload = {
      expected_state_version: args.expected_state_version,
      rules_patch_ops: rulesPatchOps,
      clock: args.clock ?? null,
      actor_updates: Array.isArray(args.actor_updates) ? args.actor_updates : [],
      project_updates: Array.isArray(args.project_updates) ? args.project_updates : [],
      combatant_updates: Array.isArray(args.combatant_updates) ? args.combatant_updates : [],
    };
    const result = await runtimeJson(env, slug, "patch", payload, "POST");
    return {
      ok: result.ok,
      error: result.error || null,
      state_version: result.state_version || result.current_state_version || null,
      context: result.snapshot ? compactSnapshot(result.snapshot) : null,
    };
  }

  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
}

function rpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

async function handleRpcMessage(message, env) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id, -32600, "Invalid Request");
  }

  const id = message.id;
  const isNotification = id === undefined || id === null;

  if (message.method === "notifications/initialized" || message.method.startsWith("notifications/")) {
    return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
  }

  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "guardian-rpg", version: MCP_SERVER_VERSION },
        instructions: "Guardian RPG is the authoritative live state bridge for The Black Menagerie. Use rpg_get_context for normal turns. If the user names a preset/framework/ruleset/spec/rule identifier, call rpg_get_named_rule first and treat a database match as authoritative. Use rpg_patch_state once per resolved stateful turn. Never advance the world clock for bookkeeping, infrastructure, or audits. When time advances, update the clock and all strategic projects consistently. Do not reveal hidden strategic details unless the campaign state establishes a valid player information path.",
      },
    };
  }

  if (message.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: mcpTools() } };
  }

  if (message.method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: [] } };
  }

  if (message.method === "prompts/list") {
    return { jsonrpc: "2.0", id, result: { prompts: [] } };
  }

  if (message.method === "tools/call") {
    if (typeof message.params?.name !== "string") {
      return rpcError(id, -32602, "Invalid params", "Missing tool name");
    }
    try {
      const data = await callMcpTool(message.params.name, message.params.arguments || {}, env);
      return { jsonrpc: "2.0", id, result: toolResult(data) };
    } catch (error) {
      const data = error?.payload || { message: error?.message || String(error) };
      const statusCode = error?.status;
      if (statusCode === 409) {
        return { jsonrpc: "2.0", id, result: toolResult(data, true) };
      }
      if (error?.code === -32601 || error?.code === -32602) {
        return rpcError(id, error.code, error.message);
      }
      return { jsonrpc: "2.0", id, result: toolResult({ error: "tool_failed", ...data }, true) };
    }
  }

  if (isNotification) return null;
  return rpcError(id, -32601, "Method not found");
}

async function handleMcp(request, env) {
  const auth = await authorizeMcp(request, env);
  if (!auth.ok) return auth.response;

  if (request.method === "GET") {
    return json({
      ok: true,
      service: "guardian-rpg-mcp",
      transport: "streamable-http",
      protocol: MCP_PROTOCOL_VERSION,
    }, 405, { allow: "POST" });
  }

  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(payload)) {
    if (!payload.length) return json(rpcError(null, -32600, "Invalid Request"), 400);
    const results = (await Promise.all(payload.map((m) => handleRpcMessage(m, env)))).filter(Boolean);
    if (!results.length) return new Response(null, { status: 202 });
    return json(results);
  }

  const result = await handleRpcMessage(payload, env);
  if (!result) return new Response(null, { status: 202 });
  return json(result);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === "/health") {
      return withCors(json({
        ok: true,
        service: "rpg-campaign-runtime",
        worker_placement: "aws:ap-southeast-2 (Sydney proximity)",
        durable_object_location_hint: "oc (Oceania, best effort)",
        db_bridge_configured: Boolean(env.RPG_DB_TOKEN),
        api_auth_configured: Boolean(env.RPG_API_TOKEN),
        mcp_endpoint: "/mcp",
        mcp_oauth_resource_metadata: "/.well-known/oauth-protected-resource",
        supabase_oauth_client_validation_configured: Boolean(env.SUPABASE_PUBLISHABLE_KEY),
      }), request);
    }

    if (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return withCors(json(resourceMetadata(request, env)), request);
    }

    if (url.pathname === "/oauth/consent") {
      return html(oauthConsentPage(env));
    }

    if (url.pathname === "/mcp") {
      return withCors(await handleMcp(request, env), request);
    }

    // Existing REST API remains protected by the original API token.
    if (!env.RPG_API_TOKEN || bearer(request) !== env.RPG_API_TOKEN) {
      return withCors(json({ ok: false, error: "unauthorized" }, 401), request);
    }

    const match = url.pathname.match(/^\/campaign\/([^/]+)\/(state|context|refresh|apply|patch)$/);
    if (!match) {
      return withCors(json({ ok: false, error: "not_found" }, 404), request);
    }

    const slug = decodeURIComponent(match[1]);
    const operation = match[2];
    const internalPath = operation;
    const internalUrl = new URL(`https://durable.internal/${internalPath}`);
    internalUrl.searchParams.set("slug", slug);

    const id = env.CAMPAIGN_RUNTIME.idFromName(slug);
    const stub = env.CAMPAIGN_RUNTIME.get(id, { locationHint: "oc" });
    const proxied = new Request(internalUrl, request);
    const response = await stub.fetch(proxied);
    return withCors(response, request);
  },
};
