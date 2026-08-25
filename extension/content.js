// Injected only on https://www.linkedin.com/in/* and /company/* (see
// manifest.json). Renders a small floating button that asks the background
// service worker to enrich the current profile/company via Clay and report
// whether it already exists in HubSpot.
//
// LinkedIn is a single-page app: navigating between profiles does not reload
// the page, so we watch history changes and re-run detection.

(function () {
  const PANEL_CSS = `
    :host {
      all: initial;
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }
    .panel {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
    }
    .main-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #0a3d62;
      color: #fff;
      border: none;
      border-radius: 999px;
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25);
    }
    .main-btn:hover:not(:disabled) {
      background: #0c4a78;
    }
    .main-btn:disabled {
      opacity: 0.7;
      cursor: default;
    }
    .icon {
      font-size: 15px;
      line-height: 1;
    }
    .status {
      max-width: 300px;
      background: #fff;
      color: #1c1c1c;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 12.5px;
      line-height: 1.4;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
      border-left: 4px solid #999;
    }
    .status.existing { border-left-color: #1a9c4b; }
    .status.triggered { border-left-color: #d98c00; }
    .status.error { border-left-color: #c62828; }
    .status a { color: #0a3d62; font-weight: 600; }
    .force-btn {
      margin-top: 6px;
      display: inline-block;
      background: none;
      border: 1px solid #999;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11.5px;
      cursor: pointer;
    }
  `;

  const HOST = document.createElement("div");
  HOST.id = "webyn-clay-enrich-host";
  const shadow = HOST.attachShadow({ mode: "closed" });

  shadow.innerHTML = `
    <div class="panel" hidden>
      <button class="main-btn" type="button">
        <span class="icon">⚡</span>
        <span class="label">Enrichir via Clay</span>
      </button>
      <div class="status" hidden></div>
    </div>
  `;

  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);

  document.documentElement.appendChild(HOST);

  const panel = shadow.querySelector(".panel");
  const mainBtn = shadow.querySelector(".main-btn");
  const label = shadow.querySelector(".label");
  const icon = shadow.querySelector(".icon");
  const status = shadow.querySelector(".status");

  let currentEntity = null; // { type: 'contact'|'company', url }
  let busy = false;

  mainBtn.addEventListener("click", () => onEnrichClick(false));

  function setStatus(html, kind) {
    status.hidden = false;
    status.className = `status ${kind || ""}`;
    status.innerHTML = html;
  }

  function clearStatus() {
    status.hidden = true;
    status.innerHTML = "";
  }

  function setBusy(isBusy, text) {
    busy = isBusy;
    mainBtn.disabled = isBusy;
    icon.textContent = isBusy ? "⏳" : "⚡";
    label.textContent = text || "Enrichir via Clay";
  }

  async function onEnrichClick(force) {
    if (busy || !currentEntity) return;
    setBusy(true, "Verification en cours…");
    clearStatus();

    let response;
    try {
      response = await sendToBackground({
        type: "ENRICH",
        payload: {
          entityType: currentEntity.type,
          linkedinUrl: currentEntity.url,
          name: currentEntity.name,
          force,
        },
      });
    } catch (err) {
      renderError("Erreur d'extension : " + describeErr(err));
      setBusy(false);
      return;
    }

    setBusy(false);

    if (!response.ok) {
      renderAuthOrError(response.error);
      return;
    }

    renderResult(response.result);
  }

  function renderAuthOrError(errorCode) {
    if (errorCode === "auth_expired" || errorCode === "no_token") {
      renderError("Connexion Google requise. Cliquez a nouveau pour vous connecter avec votre compte Webyn.");
      return;
    }
    if (errorCode === "domain_not_allowed" || errorCode === "email_not_allowed") {
      renderError("Acces reserve aux comptes Google Webyn (@webyn.ai).");
      return;
    }
    if (errorCode === "rate_limited") {
      renderError("Trop de demandes recentes, reessayez dans quelques minutes.");
      return;
    }
    renderError("Impossible de contacter le service (" + errorCode + ").");
  }

  function renderError(message) {
    setStatus(escapeHtml(message), "error");
  }

  function renderResult(result) {
    const entityLabel = result.entityType === "contact" ? "contact" : "entreprise";

    if (result.existingInHubspot) {
      const link = result.hubspotUrl
        ? `<a href="${escapeAttr(result.hubspotUrl)}" target="_blank" rel="noopener noreferrer">Voir dans HubSpot ↗</a>`
        : "Deja present dans HubSpot.";
      const extra = result.enrichmentTriggered
        ? " Un rafraichissement Clay a ete relance."
        : ` <button type="button" class="force-btn">Enrichir quand meme</button>`;
      setStatus(`✅ Ce ${entityLabel} existe deja dans HubSpot. ${link}${extra}`, "existing");

      const forceBtn = status.querySelector(".force-btn");
      if (forceBtn) {
        forceBtn.addEventListener("click", () => onEnrichClick(true));
      }
      return;
    }

    if (result.enrichmentTriggered) {
      setStatus(
        `🚀 Non trouve dans HubSpot. Enrichissement Clay lance, la fiche apparaitra dans HubSpot une fois traitee.`,
        "triggered"
      );
      return;
    }

    setStatus("Aucune action effectuee.", "neutral");
  }

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function describeErr(err) {
    return err && err.message ? err.message : String(err);
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function escapeAttr(str) {
    return String(str).replace(/"/g, "&quot;");
  }

  // ---- Page detection -----------------------------------------------------

  function detectEntity() {
    const href = location.href;

    const contactMatch = href.match(/^https:\/\/www\.linkedin\.com\/in\/([^/?#]+)/);
    if (contactMatch) {
      return {
        type: "contact",
        url: `https://www.linkedin.com/in/${contactMatch[1]}/`,
        name: extractContactName(),
      };
    }

    const companyMatch = href.match(/^https:\/\/www\.linkedin\.com\/company\/([^/?#]+)/);
    if (companyMatch) {
      return {
        type: "company",
        url: `https://www.linkedin.com/company/${companyMatch[1]}/`,
        name: extractCompanyName(),
      };
    }

    return null;
  }

  function extractContactName() {
    try {
      const h1 = document.querySelector("main h1");
      if (h1 && h1.textContent.trim()) return h1.textContent.trim();
      return (document.title || "").split(" | ")[0].trim();
    } catch {
      return "";
    }
  }

  function extractCompanyName() {
    try {
      const h1 = document.querySelector("h1");
      if (h1 && h1.textContent.trim()) return h1.textContent.trim();
      return (document.title || "").split(" | ")[0].trim();
    } catch {
      return "";
    }
  }

  function refresh() {
    const entity = detectEntity();
    currentEntity = entity;
    panel.hidden = !entity;
    if (entity) {
      setBusy(false);
      clearStatus();
    }
  }

  // Re-run detection on SPA navigation. LinkedIn does not fire popstate for
  // internal route changes, so patch history + poll as a fallback.
  const notifyLocationChanged = () => setTimeout(refresh, 300);

  for (const fn of ["pushState", "replaceState"]) {
    const original = history[fn];
    history[fn] = function (...args) {
      const result = original.apply(this, args);
      notifyLocationChanged();
      return result;
    };
  }
  window.addEventListener("popstate", notifyLocationChanged);

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      refresh();
    }
  }, 1000);

  refresh();
})();
