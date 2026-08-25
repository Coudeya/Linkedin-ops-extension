/**
 * Webyn LinkedIn -> Clay/HubSpot gateway
 *
 * This Worker is the ONLY component that holds real secrets (HubSpot private
 * app token, Clay webhook URLs). The Chrome extension never talks to HubSpot
 * or Clay directly - it only ever calls this Worker, over HTTPS, with a
 * Google OAuth access token proving the caller is signed in with a
 * @<ALLOWED_DOMAIN> Workspace account.
 *
 * Required secrets (wrangler secret put <NAME>):
 *   HUBSPOT_TOKEN            HubSpot private app token (crm.objects.contacts.read,
 *                             crm.objects.companies.read scopes)
 *   CLAY_CONTACT_WEBHOOK_URL  "Webhooks - Instant" trigger URL of the contact table
 *   CLAY_COMPANY_WEBHOOK_URL  "Webhooks - Instant" trigger URL of the company table
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
 *   RATE_LIMIT_KV binding     KV namespace used to throttle abuse (per user)
 */

const CONTACT_URL_RE = /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#]+)/i;
const COMPANY_URL_RE = /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([^/?#]+)/i;

const RATE_LIMIT_MAX_REQUESTS = 60; // per user, per hour
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

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

  return json({ error: "not_found" }, 404, request, env);
}

async function handleEnrich(request, env, ctx) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin, env)) {
    return json({ error: "forbidden_origin" }, 403, request, env);
  }

  const authHeader = request.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return json({ error: "missing_token" }, 401, request, env);
  }

  const identity = await verifyGoogleToken(match[1], env);
  if (!identity.ok) {
    return json({ error: identity.error }, 401, request, env);
  }
  const email = identity.email;

  const rateLimited = await isRateLimited(email, env);
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
    await triggerClayEnrichment(normalized, entityType, email, nameHint, env);
    enrichmentTriggered = true;
  }

  return json(
    {
      entityType,
      linkedinUrl: normalized,
      existingInHubspot: hubspotResult.exists,
      hubspotUrl: hubspotResult.url || null,
      enrichmentTriggered,
    },
    200,
    request,
    env
  );
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
    return { exists: false, url: null };
  }

  const objectType = entityType === "contact" ? "contacts" : "companies";
  const propertyName = entityType === "contact" ? "linkedinbio" : "linkedin_company_page";
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
      properties: [propertyName],
      limit: 1,
    }),
  });

  if (!res.ok) {
    console.error("hubspot_search_failed", res.status, await safeText(res));
    return { exists: false, url: null };
  }

  const data = await res.json();
  const hit = data.results && data.results[0];
  if (!hit) return { exists: false, url: null };

  const typeId = entityType === "contact" ? "0-1" : "0-2";
  const portalId = env.HUBSPOT_PORTAL_ID;
  const uiDomain = env.HUBSPOT_UI_DOMAIN || "app.hubspot.com";
  const url = portalId
    ? `https://${uiDomain}/contacts/${portalId}/record/${typeId}/${hit.id}`
    : null;

  return { exists: true, url };
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
  if (!env.RATE_LIMIT_KV) return false;

  const key = `rl:${email}`;
  const raw = await env.RATE_LIMIT_KV.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;

  if (count >= RATE_LIMIT_MAX_REQUESTS) return true;

  await env.RATE_LIMIT_KV.put(key, String(count + 1), {
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
