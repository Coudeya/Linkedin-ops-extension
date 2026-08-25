importScripts("config.js");

// Service worker: the only place that talks to the backend. Holds no
// secrets itself - it just attaches a short-lived Google OAuth access token
// (scoped to identity.email/profile only) proving the caller is signed in
// with a Webyn Google account. The backend re-validates that token and the
// account's domain before doing anything with HubSpot or Clay.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "ENRICH") {
    handleRequest("POST", "/enrich", message.payload, true)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "ENRICH_STATUS") {
    handleRequest("POST", "/enrich-status", message.payload, false)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true;
  }

  return false;
});

async function handleRequest(method, path, payload, interactive) {
  const token = await getAuthToken(interactive);

  const res = await fetch(`${BACKEND_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  if (res.status === 401) {
    // Token might be stale/revoked - drop it and let the user retry, which
    // will trigger a fresh interactive sign-in if needed.
    await clearCachedToken(token);
    throw new Error("auth_expired");
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error || "";
    } catch {
      /* ignore */
    }
    throw new Error(detail || `http_${res.status}`);
  }

  return res.json();
}

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "no_token"));
        return;
      }
      resolve(token);
    });
  });
}

function clearCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

function describeError(err) {
  return err && err.message ? err.message : String(err);
}
