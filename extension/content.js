// Injected only on https://www.linkedin.com/in/* and /company/* (see
// manifest.json). Renders a full-height side panel docked to the right
// edge (collapsible to a small vertical tab): checks HubSpot live and
// automatically as soon as a profile/company page loads, then lets the
// sales rep trigger Clay enrichment explicitly and watches it complete.
//
// LinkedIn is a single-page app: navigating between profiles does not reload
// the page, so we watch history changes and re-run detection.

(function () {
  const POLL_INTERVAL_MS = 1500;
  const POLL_MAX_ATTEMPTS = 24; // ~36s of polling

  const FIELD_ICONS = [
    [/email/i, "✉"],
    [/t.l.phone|phone/i, "☎"],
    [/poste|jobtitle/i, "💼"],
    [/entreprise|organisation|nom$/i, "🏢"],
    [/domaine/i, "🌐"],
    [/secteur/i, "🏷"],
    [/ville|pays/i, "📍"],
    [/effectif/i, "👥"],
  ];

  const PANEL_CSS = `
    :host {
      all: initial;
      position: fixed;
      top: 0;
      right: 0;
      height: 100vh;
      z-index: 2147483000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }
    * { box-sizing: border-box; }

    .tab {
      position: fixed;
      top: 50%;
      right: 0;
      transform: translateY(-50%);
      background: #0a3d62;
      color: #fff;
      padding: 14px 7px;
      border-radius: 8px 0 0 8px;
      cursor: pointer;
      font-weight: 700;
      font-size: 12.5px;
      letter-spacing: 0.04em;
      writing-mode: vertical-rl;
      box-shadow: -2px 0 10px rgba(0, 0, 0, 0.18);
      border: none;
    }
    .tab:hover { background: #0c4a78; }
    .tab[hidden] { display: none; }

    .panel {
      position: fixed;
      top: 0;
      right: 0;
      height: 100vh;
      width: 340px;
      background: #fff;
      box-shadow: -6px 0 28px rgba(0, 0, 0, 0.18);
      border-left: 1px solid #e7e9ec;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .panel[hidden] { display: none; }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid #eef0f2;
      flex: none;
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
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 6px;
    }
    .close-btn:hover { color: #475467; }

    .panel-body { flex: 1 1 auto; overflow-y: auto; }

    .profile-block {
      padding: 24px 20px 18px;
      text-align: center;
      border-bottom: 1px solid #eef0f2;
    }
    .entity-type-badge {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #0a3d62;
      background: #e7f0f7;
      border-radius: 5px;
      padding: 3px 7px;
      display: inline-block;
      margin-bottom: 10px;
    }
    .avatar {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: linear-gradient(135deg, #0a3d62, #1b6fb0);
      color: #fff;
      font-weight: 700;
      font-size: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 12px;
    }
    .profile-name {
      font-size: 16px;
      font-weight: 700;
      color: #101828;
      line-height: 1.3;
    }
    .profile-subtitle {
      font-size: 12.5px;
      color: #667085;
      margin-top: 3px;
      min-height: 16px;
    }

    .status-row { margin-top: 14px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .hs-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 700;
      padding: 6px 13px;
      border-radius: 999px;
      text-decoration: none;
      border: none;
      cursor: default;
    }
    .hs-badge.pending { background: #f2f4f7; color: #667085; }
    .hs-badge.found { background: #e6f7ec; color: #1a9c4b; cursor: pointer; }
    .hs-badge.missing { background: #fdf2e9; color: #b5540a; }
    .hs-badge .spinner {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      border: 2px solid #d0d5dd;
      border-top-color: #667085;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .clay-line {
      font-size: 11.5px;
      color: #667085;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .clay-line[hidden] { display: none; }
    .clay-line .spinner {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 2px solid #d0d5dd;
      border-top-color: #0a3d62;
      animation: spin 0.8s linear infinite;
    }
    .clay-line.done { color: #1a9c4b; }

    .section { padding: 14px 20px; border-bottom: 1px solid #eef0f2; }
    .section[hidden] { display: none; }
    .section-title {
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #98a2b3;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .field-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 6px 0;
    }
    .field-icon { flex: none; font-size: 13px; width: 18px; text-align: center; margin-top: 1px; }
    .field-text { flex: 1 1 auto; min-width: 0; }
    .field-label { display: block; font-size: 10.5px; color: #98a2b3; }
    .field-value { display: block; font-size: 12.5px; font-weight: 600; color: #101828; overflow-wrap: anywhere; }
    .field-value.missing { color: #b0b7c3; font-weight: 400; font-style: italic; }

    .note {
      font-size: 12px;
      color: #667085;
      padding: 12px 20px;
      line-height: 1.4;
    }
    .note[hidden] { display: none; }
    .note.error { color: #c62828; }

    .actions { padding: 14px 20px 20px; display: flex; flex-direction: column; gap: 8px; flex: none; }
    .actions[hidden] { display: none; }
    .btn {
      font-size: 12.5px;
      font-weight: 600;
      border-radius: 8px;
      padding: 9px 12px;
      cursor: pointer;
      border: 1px solid #d0d5dd;
      background: #fff;
      color: #101828;
      text-decoration: none;
      text-align: center;
      display: block;
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
    <button class="tab" type="button" hidden>Webyn</button>
    <aside class="panel" hidden>
      <div class="panel-header">
        <div class="brand">
          <span class="brand-badge">W</span>
          <span class="brand-title">Webyn</span>
        </div>
        <button class="close-btn" type="button" aria-label="Fermer">&times;</button>
      </div>
      <div class="panel-body">
        <div class="profile-block">
          <span class="entity-type-badge"></span>
          <div class="avatar"></div>
          <div class="profile-name"></div>
          <div class="profile-subtitle"></div>
          <div class="status-row">
            <span class="hs-badge pending"><span class="spinner"></span><span class="hs-badge-label">Verification...</span></span>
            <span class="clay-line" hidden><span class="spinner"></span><span class="clay-line-label">Enrichissement Clay en cours</span></span>
          </div>
        </div>
        <div class="section existing-section" hidden>
          <div class="section-title">Details</div>
          <div class="existing-fields"></div>
        </div>
        <div class="section new-section" hidden>
          <div class="section-title">Ajoute par Clay</div>
          <div class="new-fields"></div>
        </div>
        <div class="note" hidden></div>
      </div>
      <div class="actions"></div>
    </aside>
  `;

  document.documentElement.appendChild(HOST);

  const tabBtn = shadow.querySelector(".tab");
  const panel = shadow.querySelector(".panel");
  const closeBtn = shadow.querySelector(".close-btn");
  const entityTypeBadge = shadow.querySelector(".entity-type-badge");
  const avatarEl = shadow.querySelector(".avatar");
  const profileNameEl = shadow.querySelector(".profile-name");
  const profileSubtitleEl = shadow.querySelector(".profile-subtitle");
  const hsBadge = shadow.querySelector(".hs-badge");
  const hsBadgeLabel = shadow.querySelector(".hs-badge-label");
  const clayLine = shadow.querySelector(".clay-line");
  const clayLineLabel = shadow.querySelector(".clay-line-label");
  const existingSection = shadow.querySelector(".existing-section");
  const existingFieldsEl = shadow.querySelector(".existing-fields");
  const newSection = shadow.querySelector(".new-section");
  const newFieldsEl = shadow.querySelector(".new-fields");
  const noteEl = shadow.querySelector(".note");
  const actionsEl = shadow.querySelector(".actions");

  let currentEntity = null; // { type: 'contact'|'company', url, name }
  let pollTimer = null;
  let busy = false;

  tabBtn.addEventListener("click", () => runEnrich({ checkOnly: true }));
  closeBtn.addEventListener("click", closePanel);

  function closePanel() {
    stopPolling();
    panel.hidden = true;
    tabBtn.hidden = !currentEntity;
  }

  function openPanel() {
    tabBtn.hidden = true;
    panel.hidden = false;
  }

  function initials(name) {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    const first = parts[0][0] || "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] || "" : "";
    return (first + last).toUpperCase();
  }

  function resetPanel(entity) {
    entityTypeBadge.textContent = entity.type === "contact" ? "Contact" : "Entreprise";
    avatarEl.textContent = initials(entity.name);
    profileNameEl.textContent = entity.name || entity.url;
    profileSubtitleEl.textContent = entity.type === "contact" ? "Profil LinkedIn" : "Page entreprise LinkedIn";
    setHubspotBadge("pending", "Verification...");
    clayLine.hidden = true;
    clayLine.classList.remove("done");
    existingSection.hidden = true;
    newSection.hidden = true;
    existingFieldsEl.innerHTML = "";
    newFieldsEl.innerHTML = "";
    noteEl.hidden = true;
    noteEl.classList.remove("error");
    actionsEl.innerHTML = "";
    actionsEl.hidden = true;
  }

  function setHubspotBadge(state, label, href) {
    hsBadge.className = "hs-badge " + state;
    hsBadgeLabel.textContent = label;
    const spinner = hsBadge.querySelector(".spinner");
    if (spinner) spinner.remove();
    if (state === "pending") {
      const s = document.createElement("span");
      s.className = "spinner";
      hsBadge.prepend(s);
    }
    if (href) {
      hsBadge.onclick = () => window.open(href, "_blank", "noopener,noreferrer");
    } else {
      hsBadge.onclick = null;
    }
  }

  function fieldIcon(label) {
    for (const [re, icon] of FIELD_ICONS) {
      if (re.test(label)) return icon;
    }
    return "•";
  }

  function renderFields(container, fields) {
    container.innerHTML = "";
    const entries = Object.entries(fields || {});
    if (entries.length === 0) return false;
    for (const [label, value] of entries) {
      const row = document.createElement("div");
      row.className = "field-row";

      const icon = document.createElement("span");
      icon.className = "field-icon";
      icon.textContent = fieldIcon(label);

      const text = document.createElement("div");
      text.className = "field-text";
      const l = document.createElement("span");
      l.className = "field-label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "field-value" + (value ? "" : " missing");
      v.textContent = value || "Non renseigne";
      text.appendChild(l);
      text.appendChild(v);

      row.appendChild(icon);
      row.appendChild(text);
      container.appendChild(row);
    }
    return true;
  }

  function addAction(label, { primary, href, onClick } = {}) {
    actionsEl.hidden = false;
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

  function updateSubtitleFromFields(entity, fields) {
    if (entity.type === "contact") {
      const role = fields["Poste"];
      const company = fields["Entreprise"];
      if (role || company) {
        profileSubtitleEl.textContent = [role, company].filter(Boolean).join(" chez ");
      }
    } else {
      const industry = fields["Secteur"];
      const domain = fields["Domaine"];
      if (industry || domain) {
        profileSubtitleEl.textContent = [industry, domain].filter(Boolean).join(" · ");
      }
    }
  }

  async function runEnrich({ force = false, checkOnly = false, emailHint } = {}) {
    if (busy || !currentEntity) return;
    busy = true;
    stopPolling();
    openPanel();
    resetPanel(currentEntity);

    let response;
    try {
      response = await sendToBackground({
        type: "ENRICH",
        // Only ever pop the interactive Google sign-in prompt from an
        // explicit user click - the silent auto-check on page load must
        // never surprise a signed-out sales rep with an OS-level popup.
        interactive: !checkOnly,
        payload: {
          entityType: currentEntity.type,
          linkedinUrl: currentEntity.url,
          name: currentEntity.name,
          force,
          checkOnly,
          emailHint,
        },
      });
    } catch (err) {
      setHubspotBadge("missing", "Erreur");
      showNote("Erreur d'extension : " + describeErr(err), true);
      busy = false;
      return;
    }

    if (!response.ok) {
      setHubspotBadge("missing", "Erreur");
      showNote(authOrErrorMessage(response.error), true);
      if (response.error === "auth_expired" || response.error === "no_token") {
        addAction("Se connecter avec Google", { primary: true, onClick: () => runEnrich({}) });
      }
      busy = false;
      return;
    }

    const result = response.result;
    renderHubspotResult(result);

    if (result.enrichmentTriggered) {
      clayLine.hidden = false;
      clayLineLabel.textContent = "Enrichissement Clay en cours...";
      busy = false;
      pollForCompletion(currentEntity.type, result.linkedinUrl, 0);
      return;
    }

    busy = false;
  }

  function renderHubspotResult(result) {
    if (result.existingInHubspot) {
      setHubspotBadge("found", "Dans HubSpot ↗", result.hubspotUrl);
      existingSection.hidden = !renderFields(existingFieldsEl, result.existingFields);
      updateSubtitleFromFields(currentEntity, result.existingFields || {});
      if (!result.enrichmentTriggered) {
        addAction("Enrichir quand meme", { onClick: () => runEnrich({ force: true }) });
      }
    } else {
      setHubspotBadge("missing", "Pas encore dans HubSpot");
      if (!result.enrichmentTriggered) {
        addAction("Enrichir via Clay", { primary: true, onClick: () => runEnrich({}) });
      }
    }
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
        const fields = response.result.fields || {};
        const hasFields = renderFields(newFieldsEl, fields);
        newSection.hidden = !hasFields;
        clayLine.classList.add("done");
        clayLineLabel.textContent = "Enrichissement Clay termine";
        if (!hasFields) {
          showNote("Clay a traite la fiche mais n'a pas trouve de nouvelles informations.");
        }
        // Clay's own HubSpot sync often matches/creates records by email
        // rather than LinkedIn URL, so re-check now that we may know the
        // email - this catches "just enriched, already in HubSpot" cases.
        const emailField = Object.entries(fields).find(([label]) => /email/i.test(label));
        if (!hsBadgeIsFound() && emailField && emailField[1]) {
          recheckHubspotAfterEnrichment(entityType, linkedinUrl, emailField[1]);
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

  function hsBadgeIsFound() {
    return hsBadge.classList.contains("found");
  }

  async function recheckHubspotAfterEnrichment(entityType, linkedinUrl, emailHint) {
    let response;
    try {
      response = await sendToBackground({
        type: "ENRICH",
        interactive: false,
        payload: { entityType, linkedinUrl, checkOnly: true, emailHint },
      });
    } catch {
      return;
    }
    if (!response.ok) return;
    const result = response.result;
    if (result.existingInHubspot) {
      // Only the HubSpot status/fields refresh here - the "Ajoute par Clay"
      // section stays as-is, already showing what Clay just found.
      setHubspotBadge("found", "Dans HubSpot ↗", result.hubspotUrl);
      existingSection.hidden = !renderFields(existingFieldsEl, result.existingFields);
      updateSubtitleFromFields(currentEntity, result.existingFields || {});
    }
  }

  function finishPolling(neutral, message) {
    clayLineLabel.textContent = neutral ? "Toujours en cours (arriere-plan)" : "Enrichissement Clay";
    if (!neutral) clayLine.hidden = true;
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
      return "Connexion Google requise pour verifier HubSpot.";
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
      tabBtn.hidden = true;
      panel.hidden = true;
      return;
    }

    if (changed) {
      stopPolling();
      panel.hidden = true;
      tabBtn.hidden = true;
      busy = false;
      // Silent, free HubSpot check as soon as a new profile/company page
      // loads - no Clay credits spent unless the sales rep explicitly asks.
      runEnrich({ checkOnly: true });
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
