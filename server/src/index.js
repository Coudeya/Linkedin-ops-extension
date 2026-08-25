/**
 * Webyn LinkedIn -> Clay/HubSpot gateway
 *
 * This Worker is the ONLY component that holds real secrets (HubSpot private
 * app token, Clay webhook URLs, Clay callback secret). The Chrome extension
 * never talks to HubSpot or Clay directly - it only ever calls this Worker,
 * over HTTPS, with a Google OAuth access token proving the caller is signed
 * in with a @<ALLOWED_DOMAIN> Workspace account.
 *
 * Flow:
 *   1. Extension calls POST /enrich - Worker checks HubSpot (fast, live
 *      properties returned as `existingFields`), and if the record isn't
 *      there yet (or `force` is set) triggers the Clay webhook.
 *   2. If triggered, the extension polls GET /enrich-status until Clay
 *      finishes running that row's waterfall.
 *   3. Clay's *last* column in each table's waterfall is an outbound
 *      webhook/API action that POSTs the row's enriched fields to
 *      POST /clay-callback once the row is done. This endpoint is NOT
 *      Google-authenticated (Clay isn't a Webyn user) - it's protected by a
 *      shared secret header instead. The payload is cached briefly in KV,
 *      keyed by the normalized LinkedIn URL, for /enrich-status to read.
 *
 * Required secrets (wrangler secret put <NAME>):
 *   HUBSPOT_TOKEN              HubSpot private app token (crm.objects.contacts.read,
 *                               crm.objects.companies.read scopes)
 *   CLAY_CONTACT_WEBHOOK_URL    "Webhooks - Instant" trigger URL of the contact table
 *   CLAY_COMPANY_WEBHOOK_URL    "Webhooks - Instant" trigger URL of the company table
 *   CLAY_CALLBACK_SECRET        Shared secret Clay's outbound webhook column must send
 *                               back as the `X-Callback-Secret` header
 *
 * Required vars (wrangler.toml [vars], not secret but still not exposed to the
 * extension - only read server-side):
 *   GOOGLE_OAUTH_CLIENT_ID    Client ID configured as "Internal" in Google Cloud,
 *                             must match the one in extension/manifest.json
 *   ALLOWED_DOMAIN            e.g. "webyn.ai"
 *   ALLOWED_EXTENSION_ORIGINS Comma separated list of allowed
 *                             chrome-extension://<id> origins
 *   HUBSPOT_PORTAL_ID         Numeric HubSpot portal id, used to build deep links
 *
 * Optional:
 *   ALLOWED_EMAILS            Comma separated explicit allow-list, extra layer
 *                             on top of the domain check
 *
 * Required binding:
 *   APP_KV   KV namespace used both for per-user rate limiting and for
 *            passing the Clay completion payload from /clay-callback to
 *            /enrich-status.
 */

const CONTACT_URL_RE = /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#]+)/i;
const COMPANY_URL_RE = /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([^/?#]+)/i;

const RATE_LIMIT_MAX_REQUESTS = 60; // per user, per hour
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const COMPLETION_TTL_SECONDS = 15 * 60;

const CONTACT_PROPERTIES = [
  "linkedinbio",
  "firstname",
  "lastname",
  "email",
  "phone",
  "jobtitle",
  "company",
];
const CONTACT_PROPERTY_LABELS = {
  firstname: "Prenom",
  lastname: "Nom",
  email: "Email",
  phone: "Telephone",
  jobtitle: "Poste",
  company: "Entreprise",
};

const COMPANY_PROPERTIES = [
  "linkedin_company_page",
  "name",
  "domain",
  "industry",
  "city",
  "country",
  "numberofemployees",
];
const COMPANY_PROPERTY_LABELS = {
  name: "Nom",
  domain: "Domaine",
  industry: "Secteur",
  city: "Ville",
  country: "Pays",
  numberofemployees: "Effectif",
};

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error("unhandled_error", err && err.stack ? err.stack : err);
      return json({ error: "internal_error" }, 500, request, env);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return corsPreflight(request, env);
  }

  if (url.pathname === "/health" && request.method === "GET") {
    return json({ ok: true }, 200, request, env);
  }

  if (url.pathname === "/enrich" && request.method === "POST") {
    return handleEnrich(request, env, ctx);
  }

  if (url.pathname === "/enrich-status" && request.method === "GET") {
    return handleEnrichStatus(request, env, ctx);
  }

  if (url.pathname === "/clay-callback" && request.method === "POST") {
    return handleClayCallback(request, env, ctx);
  }

  return json({ error: "not_found" }, 404, request, env);
}

async function authenticate(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin, env)) {
    return { ok: false, error: "forbidden_origin", status: 403 };
  }

  const authHeader = request.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, error: "missing_token", status: 401 };
  }

  const identity = await verifyGoogleToken(match[1], env);
  if (!identity.ok) {
    return { ok: false, error: identity.error, status: 401 };
  }

  return { ok: true, email: identity.email };
}

async function handleEnrich(request, env, ctx) {
  const auth = await authenticate(request, env);
  if (!auth.ok) return json({ error: auth.error }, auth.status, request, env);

  const rateLimited = await isRateLimited(auth.email, env);
  if (rateLimited) {
    return json({ error: "rate_limited" }, 429, request, env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, request, env);
  }

  const entityType = body.entityType;
  const force = body.force === true;
  const nameHint = typeof body.name === "string" ? body.name.slice(0, 200) : undefined;

  if (entityType !== "contact" && entityType !== "company") {
    return json({ error: "invalid_entity_type" }, 400, request, env);
  }

  const normalized = normalizeLinkedInUrl(body.linkedinUrl, entityType);
  if (!normalized) {
    return json({ error: "invalid_linkedin_url" }, 400, request, env);
  }

  const hubspotResult = await lookupInHubspot(normalized, entityType, env);

  let enrichmentTriggered = false;
  if (!hubspotResult.exists || force) {
    await clearCompletion(normalized, entityType, env);
    await triggerClayEnrichment(normalized, entityType, auth.email, nameHint, env);
    enrichmentTriggered = true;
  }

  return json(
    {
      entityType,
      linkedinUrl: normalized,
      existingInHubspot: hubspotResult.exists,
      hubspotUrl: hubspotResult.url || null,
      existingFields: hubspotResult.fields || null,
      enrichmentTriggered,
    },
    200,
    request,
    env
  );
}

async function handleEnrichStatus(request, env, ctx) {
  const auth = await authenticate(request, env);
  if (!auth.ok) return json({ error: auth.error }, auth.status, request, env);

  const url = new URL(request.url);
  const entityType = url.searchParams.get("entityType");
  const rawLinkedinUrl = url.searchParams.get("linkedinUrl") || "";

  if (entityType !== "contact" && entityType !== "company") {
    return json({ error: "invalid_entity_type" }, 400, request, env);
  }

  const normalized = normalizeLinkedInUrl(rawLinkedinUrl, entityType);
  if (!normalized) {
    return json({ error: "invalid_linkedin_url" }, 400, request, env);
  }

  if (!env.APP_KV) {
    return json({ status: "unavailable" }, 200, request, env);
  }

  const raw = await env.APP_KV.get(completionKey(normalized, entityType));
  if (!raw) {
    return json({ status: "pending" }, 200, request, env);
  }

  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return json({ status: "pending" }, 200, request, env);
  }

  return json({ status: "done", fields: stored.fields || {} }, 200, request, env);
}

async function handleClayCallback(request, env, ctx) {
  const secret = request.headers.get("X-Callback-Secret") || "";
  if (!env.CLAY_CALLBACK_SECRET || secret !== env.CLAY_CALLBACK_SECRET) {
    return json({ error: "forbidden" }, 403, request, env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, request, env);
  }

  const entityType = body.entityType;
  if (entityType !== "contact" && entityType !== "company") {
    return json({ error: "invalid_entity_type" }, 400, request, env);
  }

  const normalized = normalizeLinkedInUrl(body.linkedinUrl, entityType);
  if (!normalized) {
    return json({ error: "invalid_linkedin_url" }, 400, request, env);
  }

  // Accept either a nested {"fields": {...}} object, or - to make the Clay
  // side easier to build - any other top-level keys treated directly as
  // fields (i.e. just POST {"entityType": "...", "linkedinUrl": "...",
  // "Telephone": "...", "Email": "..."}).
  const RESERVED_KEYS = new Set(["entityType", "linkedinUrl", "fields"]);
  let fields = {};
  if (body.fields && typeof body.fields === "object") {
    fields = body.fields;
  } else {
    for (const [key, value] of Object.entries(body)) {
      if (!RESERVED_KEYS.has(key) && value !== null && value !== undefined && value !== "") {
        fields[key] = value;
      }
    }
  }

  if (!env.APP_KV) {
    console.warn("app_kv_missing_cannot_store_completion");
    return json({ ok: true, stored: false }, 200, request, env);
  }

  await env.APP_KV.put(
    completionKey(normalized, entityType),
    JSON.stringify({ fields, receivedAt: new Date().toISOString() }),
    { expirationTtl: COMPLETION_TTL_SECONDS }
  );

  return json({ ok: true, stored: true }, 200, request, env);
}

function completionKey(linkedinUrl, entityType) {
  return `done:${entityType}:${linkedinUrl}`;
}

async function clearCompletion(linkedinUrl, entityType, env) {
  if (!env.APP_KV) return;
  await env.APP_KV.delete(completionKey(linkedinUrl, entityType));
}

function normalizeLinkedInUrl(raw, entityType) {
  if (typeof raw !== "string" || raw.length > 500) return null;
  const re = entityType === "contact" ? CONTACT_URL_RE : COMPANY_URL_RE;
  const m = raw.match(re);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  const segment = entityType === "contact" ? "in" : "company";
  return `https://www.linkedin.com/${segment}/${slug}/`;
}

async function lookupInHubspot(linkedinUrl, entityType, env) {
  if (!env.HUBSPOT_TOKEN) {
    console.warn("hubspot_token_missing");
    return { exists: false, url: null, fields: null };
  }

  const objectType = entityType === "contact" ? "contacts" : "companies";
  const propertyName = entityType === "contact" ? "linkedinbio" : "linkedin_company_page";
  const properties = entityType === "contact" ? CONTACT_PROPERTIES : COMPANY_PROPERTIES;
  const labels = entityType === "contact" ? CONTACT_PROPERTY_LABELS : COMPANY_PROPERTY_LABELS;
  // Also try without the trailing slash, since existing HubSpot records may
  // have been stored without one.
  const bareUrl = linkedinUrl.replace(/\/$/, "");

  const res = await fetch(`https://api.hubapi.com/crm/v3/objects/${objectType}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filterGroups: [
        { filters: [{ propertyName, operator: "EQ", value: linkedinUrl }] },
        { filters: [{ propertyName, operator: "EQ", value: bareUrl }] },
      ],
      properties,
      limit: 1,
    }),
  });

  if (!res.ok) {
    console.error("hubspot_search_failed", res.status, await safeText(res));
    return { exists: false, url: null, fields: null };
  }

  const data = await res.json();
  const hit = data.results && data.results[0];
  if (!hit) return { exists: false, url: null, fields: null };

  const typeId = entityType === "contact" ? "0-1" : "0-2";
  const portalId = env.HUBSPOT_PORTAL_ID;
  const uiDomain = env.HUBSPOT_UI_DOMAIN || "app.hubspot.com";
  const url = portalId
    ? `https://${uiDomain}/contacts/${portalId}/record/${typeId}/${hit.id}`
    : null;

  const fields = {};
  for (const [key, label] of Object.entries(labels)) {
    const value = hit.properties && hit.properties[key];
    if (value) fields[label] = value;
  }

  return { exists: true, url, fields };
}

async function triggerClayEnrichment(linkedinUrl, entityType, requestedByEmail, nameHint, env) {
  const webhookUrl =
    entityType === "contact" ? env.CLAY_CONTACT_WEBHOOK_URL : env.CLAY_COMPANY_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn("clay_webhook_missing", entityType);
    return;
  }

  const payload = {
    "LinkedIn URL": linkedinUrl,
    "Name": nameHint || "",
    "Requested by": requestedByEmail,
    "Requested at": new Date().toISOString(),
    "Source": "linkedin-ops-extension",
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error("clay_webhook_failed", entityType, res.status, await safeText(res));
  }
}

async function verifyGoogleToken(accessToken, env) {
  if (!/^[A-Za-z0-9._-]{20,2048}$/.test(accessToken)) {
    return { ok: false, error: "malformed_token" };
  }

  let res;
  try {
    res = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
    );
  } catch {
    return { ok: false, error: "google_unreachable" };
  }

  if (!res.ok) {
    return { ok: false, error: "invalid_token" };
  }

  const info = await res.json();

  const expectedClientIds = (env.GOOGLE_OAUTH_CLIENT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (expectedClientIds.length === 0 || !expectedClientIds.includes(info.aud)) {
    return { ok: false, error: "unexpected_audience" };
  }

  if (info.email_verified !== "true" && info.email_verified !== true) {
    return { ok: false, error: "email_not_verified" };
  }

  const email = (info.email || "").toLowerCase();
  const allowedDomain = (env.ALLOWED_DOMAIN || "").toLowerCase();
  if (!allowedDomain || !email.endsWith(`@${allowedDomain}`)) {
    return { ok: false, error: "domain_not_allowed" };
  }

  const allowList = (env.ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowList.length > 0 && !allowList.includes(email)) {
    return { ok: false, error: "email_not_allowed" };
  }

  return { ok: true, email };
}

async function isRateLimited(email, env) {
  if (!env.APP_KV) return false;

  const key = `rl:${email}`;
  const raw = await env.APP_KV.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;

  if (count >= RATE_LIMIT_MAX_REQUESTS) return true;

  await env.APP_KV.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });
  return false;
}

function isAllowedOrigin(origin, env) {
  const allowed = (env.ALLOWED_EXTENSION_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = { Vary: "Origin" };
  if (isAllowedOrigin(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}

function corsPreflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request, env),
    },
  });
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}
