// Injected only on https://www.linkedin.com/in/* and /company/* (see
// manifest.json). Renders a floating launcher that expands into a card:
// checks HubSpot live, triggers Clay enrichment when needed, then polls the
// backend until Clay's waterfall finishes on that row and shows the result.
//
// LinkedIn is a single-page app: navigating between profiles does not reload
// the page, so we watch history changes and re-run detection.

(function () {
  const POLL_INTERVAL_MS = 1500;
  const POLL_MAX_ATTEMPTS = 14; // ~21s of polling

  const PANEL_CSS = `
    :host {
      all: initial;
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }
    * { box-sizing: border-box; }

    .launcher {
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
    .launcher:hover { background: #0c4a78; }
    .launcher[hidden] { display: none; }

    .card {
      width: 320px;
      max-height: 80vh;
      overflow-y: auto;
      background: #fff;
      border-radius: 14px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
      border: 1px solid #e7e9ec;
    }
    .card[hidden] { display: none; }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 14px 10px;
      border-bottom: 1px solid #eef0f2;
    }
    .brand { display: flex; align-items: center; gap: 8px; }
    .brand-badge {
      width: 24px;
      height: 24px;
      border-radius: 7px;
      background: #0a3d62;
      color: #fff;
      font-weight: 700;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .brand-title { font-weight: 700; font-size: 14px; color: #101828; }
    .close-btn {
      background: none;
      border: none;
      color: #98a2b3;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 4px;
    }
    .close-btn:hover { color: #475467; }

    .entity-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 14px 4px;
    }
    .entity-type-badge {
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #0a3d62;
      background: #e7f0f7;
      border-radius: 5px;
      padding: 3px 6px;
      white-space: nowrap;
    }
    .entity-name {
      font-size: 13.5px;
      font-weight: 600;
      color: #101828;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .steps { padding: 10px 14px 2px; display: flex; flex-direction: column; gap: 8px; }
    .step {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      color: #475467;
    }
    .step[hidden] { display: none; }
    .step-icon {
      width: 16px;
      height: 16px;
      flex: none;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      border-radius: 50%;
    }
    .step[data-state="pending"] .step-icon {
      border: 2px solid #d0d5dd;
      border-top-color: #0a3d62;
      animation: spin 0.8s linear infinite;
    }
    .step[data-state="done"] .step-icon { color: #1a9c4b; }
    .step[data-state="done"] .step-icon::before { content: "\\2713"; }
    .step[data-state="idle"] .step-icon { color: #d0d5dd; }
    .step[data-state="idle"] .step-icon::before { content: "\\25CB"; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .section { padding: 10px 14px; }
    .section[hidden] { display: none; }
    .section-title {
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #98a2b3;
      margin-bottom: 6px;
    }
    .field-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 4px 0;
      font-size: 12.5px;
      border-bottom: 1px solid #f5f6f8;
    }
    .field-row:last-child { border-bottom: none; }
    .field-label { color: #667085; flex: none; }
    .field-value { color: #101828; font-weight: 600; text-align: right; overflow-wrap: anywhere; }

    .note {
      font-size: 12px;
      color: #667085;
      padding: 2px 14px 10px;
      line-height: 1.4;
    }
    .note.error { color: #c62828; }

    .actions { display: flex; gap: 8px; padding: 6px 14px 14px; flex-wrap: wrap; }
    .btn {
      font-size: 12px;
      font-weight: 600;
      border-radius: 8px;
      padding: 7px 10px;
      cursor: pointer;
      border: 1px solid #d0d5dd;
      background: #fff;
      color: #101828;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
    }
    .btn:hover { background: #f9fafb; }
    .btn.primary { background: #0a3d62; color: #fff; border-color: #0a3d62; }
    .btn.primary:hover { background: #0c4a78; }
  `;

  const HOST = document.createElement("div");
  HOST.id = "webyn-clay-enrich-host";
  const shadow = HOST.attachShadow({ mode: "closed" });

  shadow.innerHTML = `
    <style>${PANEL_CSS}</style>
    <button class="launcher" type="button" hidden>
      <span>⚡</span>
      <span>Enrichir via Clay</span>
    </button>
    <div class="card" hidden>
      <div class="card-header">
        <div class="brand">
          <span class="brand-badge">W</span>
          <span class="brand-title">Webyn</span>
        </div>
        <button class="close-btn" type="button" aria-label="Fermer">&times;</button>
      </div>
      <div class="entity-row">
        <span class="entity-type-badge"></span>
        <span class="entity-name"></span>
      </div>
      <div class="steps">
        <div class="step" data-step="hubspot" data-state="idle">
          <span class="step-icon"></span>
          <span>Verification HubSpot</span>
        </div>
        <div class="step" data-step="clay" data-state="idle" hidden>
          <span class="step-icon"></span>
          <span class="clay-step-label">Enrichissement Clay</span>
        </div>
      </div>
      <div class="section existing-section" hidden>
        <div class="section-title">Deja dans HubSpot</div>
        <div class="existing-fields"></div>
      </div>
      <div class="section new-section" hidden>
        <div class="section-title">Ajoute par Clay</div>
        <div class="new-fields"></div>
      </div>
      <div class="note" hidden></div>
      <div class="actions"></div>
    </div>
  `;

  document.documentElement.appendChild(HOST);

  const launcher = shadow.querySelector(".launcher");
  const card = shadow.querySelector(".card");
  const closeBtn = shadow.querySelector(".close-btn");
  const entityTypeBadge = shadow.querySelector(".entity-type-badge");
  const entityNameEl = shadow.querySelector(".entity-name");
  const hubspotStep = shadow.querySelector('.step[data-step="hubspot"]');
  const clayStep = shadow.querySelector('.step[data-step="clay"]');
  const clayStepLabel = shadow.querySelector(".clay-step-label");
  const existingSection = shadow.querySelector(".existing-section");
  const existingFieldsEl = shadow.querySelector(".existing-fields");
  const newSection = shadow.querySelector(".new-section");
  const newFieldsEl = shadow.querySelector(".new-fields");
  const noteEl = shadow.querySelector(".note");
  const actionsEl = shadow.querySelector(".actions");

  let currentEntity = null; // { type: 'contact'|'company', url, name }
  let pollTimer = null;
  let busy = false;

  launcher.addEventListener("click", () => runEnrich(false));
  closeBtn.addEventListener("click", closeCard);

  function closeCard() {
    stopPolling();
    card.hidden = true;
    launcher.hidden = !currentEntity;
  }

  function openCard() {
    launcher.hidden = true;
    card.hidden = false;
  }

  function resetCard(entity) {
    entityTypeBadge.textContent = entity.type === "contact" ? "Contact" : "Entreprise";
    entityNameEl.textContent = entity.name || entity.url;
    setStep(hubspotStep, "pending");
    clayStep.hidden = true;
    setStep(clayStep, "idle");
    existingSection.hidden = true;
    newSection.hidden = true;
    existingFieldsEl.innerHTML = "";
    newFieldsEl.innerHTML = "";
    noteEl.hidden = true;
    noteEl.classList.remove("error");
    actionsEl.innerHTML = "";
  }

  function setStep(stepEl, state) {
    stepEl.dataset.state = state;
  }

  function renderFields(container, fields) {
    container.innerHTML = "";
    const entries = Object.entries(fields || {});
    if (entries.length === 0) return false;
    for (const [label, value] of entries) {
      const row = document.createElement("div");
      row.className = "field-row";
      const l = document.createElement("span");
      l.className = "field-label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "field-value";
      v.textContent = value;
      row.appendChild(l);
      row.appendChild(v);
      container.appendChild(row);
    }
    return true;
  }

  function addAction(label, { primary, href, onClick } = {}) {
    const el = document.createElement(href ? "a" : "button");
    el.className = "btn" + (primary ? " primary" : "");
    el.textContent = label;
    if (href) {
      el.href = href;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
    } else {
      el.type = "button";
      el.addEventListener("click", onClick);
    }
    actionsEl.appendChild(el);
  }

  function showNote(text, isError) {
    noteEl.hidden = false;
    noteEl.textContent = text;
    noteEl.classList.toggle("error", !!isError);
  }

  async function runEnrich(force) {
    if (busy || !currentEntity) return;
    busy = true;
    stopPolling();
    openCard();
    resetCard(currentEntity);

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
      setStep(hubspotStep, "idle");
      showNote("Erreur d'extension : " + describeErr(err), true);
      busy = false;
      return;
    }

    if (!response.ok) {
      setStep(hubspotStep, "idle");
      showNote(authOrErrorMessage(response.error), true);
      busy = false;
      return;
    }

    setStep(hubspotStep, "done");
    const result = response.result;

    if (result.existingInHubspot) {
      existingSection.hidden = !renderFields(existingFieldsEl, result.existingFields);
      if (result.hubspotUrl) {
        addAction("Voir dans HubSpot", { href: result.hubspotUrl });
      }
      if (!result.enrichmentTriggered) {
        addAction("Enrichir quand meme", { onClick: () => runEnrich(true) });
      }
    }

    if (result.enrichmentTriggered) {
      clayStep.hidden = false;
      setStep(clayStep, "pending");
      clayStepLabel.textContent = "Enrichissement Clay en cours...";
      busy = false;
      pollForCompletion(currentEntity.type, result.linkedinUrl, 0);
      return;
    }

    busy = false;
  }

  const FATAL_POLL_ERRORS = new Set([
    "auth_expired",
    "no_token",
    "domain_not_allowed",
    "email_not_allowed",
  ]);

  function pollForCompletion(entityType, linkedinUrl, attempt) {
    pollTimer = setTimeout(async () => {
      let response;
      try {
        response = await sendToBackground({
          type: "ENRICH_STATUS",
          payload: { entityType, linkedinUrl },
        });
      } catch (err) {
        // Transient (extension messaging hiccup, network blip) - keep retrying.
        if (attempt + 1 >= POLL_MAX_ATTEMPTS) {
          finishPolling(false, "Erreur pendant le suivi de l'enrichissement : " + describeErr(err));
          return;
        }
        pollForCompletion(entityType, linkedinUrl, attempt + 1);
        return;
      }

      if (!response.ok) {
        // A permanent auth/permission error stops immediately; anything else
        // (a transient backend hiccup) is retried like a "pending" status.
        if (FATAL_POLL_ERRORS.has(response.error) || attempt + 1 >= POLL_MAX_ATTEMPTS) {
          finishPolling(false, authOrErrorMessage(response.error));
          return;
        }
        pollForCompletion(entityType, linkedinUrl, attempt + 1);
        return;
      }

      const status = response.result.status;

      if (status === "done") {
        const hasFields = renderFields(newFieldsEl, response.result.fields);
        newSection.hidden = !hasFields;
        setStep(clayStep, "done");
        clayStepLabel.textContent = "Enrichissement Clay termine";
        if (!hasFields) {
          showNote("Clay a traite la fiche mais n'a pas trouve de nouvelles informations.");
        }
        return;
      }

      if (status === "unavailable" || attempt + 1 >= POLL_MAX_ATTEMPTS) {
        finishPolling(
          true,
          "Toujours en cours de traitement chez Clay - la fiche apparaitra dans HubSpot une fois terminee."
        );
        return;
      }

      pollForCompletion(entityType, linkedinUrl, attempt + 1);
    }, POLL_INTERVAL_MS);
  }

  function finishPolling(neutral, message) {
    clayStepLabel.textContent = neutral ? "Enrichissement Clay en cours (arriere-plan)" : "Enrichissement Clay";
    setStep(clayStep, "idle");
    showNote(message, !neutral);
  }

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function authOrErrorMessage(errorCode) {
    if (errorCode === "auth_expired" || errorCode === "no_token") {
      return "Connexion Google requise. Fermez puis cliquez a nouveau pour vous connecter avec votre compte Webyn.";
    }
    if (errorCode === "domain_not_allowed" || errorCode === "email_not_allowed") {
      return "Acces reserve aux comptes Google Webyn (@webyn.ai).";
    }
    if (errorCode === "rate_limited") {
      return "Trop de demandes recentes, reessayez dans quelques minutes.";
    }
    return "Impossible de contacter le service (" + errorCode + ").";
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
    const changed = !currentEntity || !entity || entity.url !== currentEntity.url;
    currentEntity = entity;

    if (!entity) {
      launcher.hidden = true;
      card.hidden = true;
      return;
    }

    if (changed) {
      stopPolling();
      card.hidden = true;
      launcher.hidden = false;
      busy = false;
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
