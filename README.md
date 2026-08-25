# Webyn — LinkedIn → Clay/HubSpot

Extension Chrome interne pour les sales Webyn. Sur une page profil ou
entreprise LinkedIn, un bouton flottant :

1. vérifie **immédiatement** si le contact/l'entreprise existe déjà dans
   HubSpot ;
2. si ce n'est pas le cas, **déclenche l'enrichissement Clay** en poussant
   l'URL LinkedIn dans la table Clay dédiée (contacts ou entreprises).

Plus besoin de copier-coller l'URL LinkedIn dans Clay à la main.

## Architecture

```
LinkedIn (profil/entreprise)
        │  bouton flottant (content script)
        ▼
Extension Chrome (MV3)
  - background.js : récupère un jeton OAuth Google (compte @webyn.ai)
  - aucun secret stocké côté extension
        │  HTTPS + Authorization: Bearer <token Google>
        ▼
Worker Cloudflare (server/)         <-- seul composant qui détient les secrets
  1. Vérifie le jeton Google (audience + domaine @webyn.ai)
  2. Cherche le contact/l'entreprise dans HubSpot
       - contacts   : propriété `linkedinbio`
       - entreprises: propriété `linkedin_company_page`
  3. Si absent (ou "Enrichir quand même") : POST vers le webhook Clay
        │                                   │
        ▼                                   ▼
     HubSpot API                    Webhook Clay (table dédiée)
```

Le principe de sécurité central : **l'extension ne connaît jamais le token
HubSpot ni les URLs de webhook Clay**. Elle ne peut faire qu'une seule chose
— appeler `/enrich` sur le Worker — et seulement si elle présente un jeton
Google valide, encore vérifié côté serveur, pour un compte du domaine
`webyn.ai`.

### Suivi en temps réel de l'enrichissement Clay

Clay ne propose pas de webhook entrant "synchrone" (qui attendrait que les
colonnes soient calculées avant de répondre). Le suivi fonctionne donc en
deux temps :

1. La **dernière colonne** de chaque table Clay (contacts et entreprises)
   est une colonne **HTTP API** sortante qui POST les champs enrichis vers
   `POST /clay-callback` dès que la ligne a fini de tourner. Cet endpoint
   n'est pas authentifié par Google (Clay n'est pas un compte Webyn) mais
   par un secret partagé (`CLAY_CALLBACK_SECRET`, header
   `X-Callback-Secret`). Le payload attendu est plat :
   `{"entityType": "contact"|"company", "linkedinUrl": "...", "Champ 1": "...", "Champ 2": "..."}`
   — chaque clé autre que `entityType`/`linkedinUrl` devient un champ
   affiché dans l'extension comme "ajouté par Clay".
2. Le Worker stocke ce payload dans **Cloudflare KV** (binding `APP_KV`),
   pendant 15 minutes, indexé par URL LinkedIn normalisée.
3. L'extension appelle `GET /enrich-status` toutes les ~1,5s (jusqu'à ~21s)
   après avoir déclenché l'enrichissement, pour savoir si le résultat est
   arrivé.

Point d'attention en configurant la colonne HTTP API côté Clay : chaque
champ inséré dans le Body via `/` doit être marqué **optionnel** (toggle
désactivé), sinon Clay refuse de lancer l'appel dès qu'un des champs
référencés est vide sur une ligne ("Some inputs missing") — seul le champ
LinkedIn URL doit rester obligatoire.

## Pourquoi ces choix de sécurité

- **Compte Google restreint au domaine `webyn.ai`** : le client OAuth est
  publié en mode *Interne* dans Google Cloud, donc seul un compte Google
  Workspace de `webyn.ai` peut même donner son consentement. Le Worker
  revérifie ensuite le token (audience + domaine + email vérifié) : même si
  un jeton fuitait, il ne servirait à rien pour un compte externe.
- **Aucun secret dans l'extension** : le code JS d'une extension Chrome est
  entièrement lisible par quiconque l'installe. Le token privé HubSpot et
  les URLs de webhook Clay ne sont donc *jamais* écrits dans `extension/` —
  uniquement dans les secrets du Worker Cloudflare.
- **CORS strict** : le Worker n'accepte des requêtes que depuis l'origine
  `chrome-extension://<ID_FIXE_DE_L_EXTENSION>` (l'ID est figé grâce à la
  clé publique déjà présente dans `manifest.json`).
- **Validation stricte de l'URL LinkedIn** envoyée au Worker (regex sur
  `linkedin.com/in/...` ou `/company/...`) avant tout appel à HubSpot/Clay.
- **Rate limiting optionnel** par utilisateur (voir `RATE_LIMIT_KV`) pour
  éviter un usage abusif ou un script qui tournerait en boucle.
- **Permissions minimales** : l'extension ne demande que `identity` et
  `storage`, et n'a de `host_permissions` que sur le Worker. Le content
  script n'est injecté que sur `linkedin.com/in/*` et `linkedin.com/company/*`.

## 1. Prérequis

- Un compte [Cloudflare](https://dash.cloudflare.com/) (le plan gratuit
  suffit largement) pour héberger le Worker.
- Accès admin à la Google Cloud Console de Webyn (ou création d'un nouveau
  projet) pour l'écran de consentement OAuth interne.
- Un **token privé HubSpot** (Private App) avec les scopes en lecture :
  `crm.objects.contacts.read`, `crm.objects.companies.read`.
- Les deux tables Clay existantes :
  - Contacts : https://app.clay.com/workspaces/370007/tables/t_0swb3xhgpd2RDNzpUPx
  - Entreprises : https://app.clay.com/workspaces/370007/tables/t_0t6qmul4jBTsKbuDX9t
- Node.js 18+ pour utiliser `wrangler` (CLI Cloudflare).

## 2. Configurer les webhooks Clay

Sur **chaque** table (contacts et entreprises) :

1. Ouvrir la table → source d'entrée → ajouter **"Webhooks - Instant"** (ou
   "HTTP API" selon la version de Clay).
2. Copier l'URL générée par Clay (`https://api.clay.com/v3/sources/webhook/...`).
3. Dans les colonnes de mapping du webhook, s'assurer que les clés
   suivantes existent (ce sont celles envoyées par le Worker) :
   - `LinkedIn URL` → colonne servant à l'enrichissement (identifiant
     LinkedIn de la table)
   - `Name` (optionnel, meilleur effort)
   - `Requested by` (email du sales, pour traçabilité)
   - `Requested at` (horodatage ISO)
   - `Source` (toujours `linkedin-ops-extension`)

Gardez les deux URLs de côté, elles seront mises en secret dans le Worker
(`CLAY_CONTACT_WEBHOOK_URL`, `CLAY_COMPANY_WEBHOOK_URL`).

## 3. Créer le token privé HubSpot

1. HubSpot → Paramètres → Intégrations → Applications privées → Créer.
2. Scopes en lecture seule : `crm.objects.contacts.read`,
   `crm.objects.companies.read`.
3. Copier le token (`pat-...`), il sera mis en secret
   (`HUBSPOT_TOKEN`) dans le Worker.
4. Noter l'ID de portail HubSpot (visible dans l'URL `app.hubspot.com/.../<portalId>/...`)
   pour `HUBSPOT_PORTAL_ID` (sert uniquement à construire les liens directs
   vers les fiches).

> Les propriétés utilisées pour la recherche (`linkedinbio` sur les contacts,
> `linkedin_company_page` sur les entreprises) existent déjà par défaut dans
> ce portail HubSpot — aucune configuration supplémentaire n'est nécessaire
> côté HubSpot.

## 4. Créer les identifiants OAuth Google (accès réservé à `webyn.ai`)

1. [Google Cloud Console](https://console.cloud.google.com/) → créer/choisir
   un projet dédié (ex. `webyn-linkedin-ops`).
2. **Écran de consentement OAuth** → type **Interne** (réservé à
   l'organisation Google Workspace `webyn.ai` — un compte externe ne pourra
   jamais s'y connecter).
3. **Identifiants** → Créer des identifiants → **ID client OAuth** → type
   **Application Chrome** → renseigner l'ID de l'extension (voir étape 6,
   il est déjà fixé dans `manifest.json` : `gnbddgombfbmjcdhaafkjccnodbfpplp`).
4. Copier le **Client ID** généré (`....apps.googleusercontent.com`).

## 5. Déployer le Worker Cloudflare

```bash
cd server
npm install
npx wrangler login

# KV namespace (rate limiting + suivi de l'enrichissement Clay)
npx wrangler kv namespace create APP_KV
# -> coller l'id renvoyé dans le binding [[kv_namespaces]] de wrangler.toml

# Secrets (jamais commités)
npx wrangler secret put HUBSPOT_TOKEN
npx wrangler secret put CLAY_CONTACT_WEBHOOK_URL
npx wrangler secret put CLAY_COMPANY_WEBHOOK_URL
npx wrangler secret put CLAY_CALLBACK_SECRET
# -> generer une valeur aleatoire, ex: openssl rand -hex 32
```

Éditer `server/wrangler.toml` :

- `GOOGLE_OAUTH_CLIENT_ID` → le Client ID de l'étape 4
- `HUBSPOT_PORTAL_ID` → l'ID de portail de l'étape 3
- `ALLOWED_EXTENSION_ORIGINS` → déjà pré-rempli avec l'ID fixe de
  l'extension (`chrome-extension://gnbddgombfbmjcdhaafkjccnodbfpplp`) ; à
  changer uniquement si vous régénérez la clé de `manifest.json`
- (optionnel) `ALLOWED_EMAILS` pour restreindre à une liste explicite de
  sales en plus du domaine `webyn.ai`

Puis déployer :

```bash
npx wrangler deploy
```

Notez l'URL du Worker affichée (`https://webyn-linkedin-clay-gateway.<sous-domaine>.workers.dev`).

### Colonne HTTP API sortante dans Clay

Sur **chaque** table Clay (contacts et entreprises), ajoutez une colonne de
type **"HTTP API"** tout à la fin du waterfall :

- Method : `POST`
- Endpoint : `https://<url-du-worker>/clay-callback`
- Headers : `Content-Type: application/json`,
  `X-Callback-Secret: <valeur de CLAY_CALLBACK_SECRET>`
- Body (JSON, avec les colonnes inserees via `/`) :
  `{"entityType": "contact", "linkedinUrl": "<colonne LinkedIn>", "Telephone": "<colonne>", "Email": "<colonne>", ...}`
  (`"company"` pour la table entreprises)
- Marquez **optionnel** (toggle desactive) tous les champs sauf
  `linkedinUrl`, sinon Clay saute l'appel des qu'un champ reference est vide
  sur une ligne.
- Verifiez qu'"Auto-run" est actif pour cette colonne.

## 6. Configurer l'extension

Deux fichiers à éditer avec l'URL du Worker obtenue à l'étape 5 :

- `extension/config.js` → `BACKEND_BASE_URL`
- `extension/manifest.json` → `host_permissions` (remplacer
  `https://REPLACE_ME.workers.dev/*`)
- `extension/manifest.json` → `oauth2.client_id` (Client ID de l'étape 4)

La clé `manifest.json` → `key` est déjà générée et **ne doit pas changer** :
elle fixe l'ID de l'extension à `gnbddgombfbmjcdhaafkjccnodbfpplp`, qui doit
correspondre à celui déclaré dans les identifiants OAuth Google (étape 4) et
dans `ALLOWED_EXTENSION_ORIGINS` du Worker.

## 7. Charger l'extension dans Chrome

1. `chrome://extensions`
2. Activer le **Mode développeur**
3. **Charger l'extension non empaquetée** → sélectionner le dossier
   `extension/`
4. Ouvrir un profil LinkedIn : le bouton **"Enrichir via Clay"** doit
   apparaître en bas à droite.

Pour distribuer à toute l'équipe sans que chaque sales ne fasse ces étapes
manuellement, publier l'extension en **privé/non répertorié** sur le Chrome
Web Store (accès restreint aux comptes `@webyn.ai`) ou la déployer via une
politique Google Workspace (`ExtensionInstallForcelist`) — dans les deux cas
l'ID reste `gnbddgombfbmjcdhaafkjccnodbfpplp` grâce à la clé fixée dans le
manifest.

## Utilisation

- Sur un profil : clic → vérifie `linkedinbio` dans HubSpot.
- Sur une page entreprise : clic → vérifie `linkedin_company_page` dans
  HubSpot.
- Si déjà présent : lien direct vers la fiche HubSpot, avec un bouton
  secondaire **"Enrichir quand même"** pour forcer un rafraîchissement Clay.
- Si absent : l'enrichissement Clay est lancé immédiatement (asynchrone —
  la fiche apparaîtra dans HubSpot une fois le waterfall Clay terminé).

## Limites connues

- La correspondance HubSpot se fait par égalité exacte sur l'URL LinkedIn
  normalisée. Si une fiche existante contient une URL LinkedIn mal formatée
  ou différente (ex. ancien slug), elle ne sera pas retrouvée et
  l'enrichissement Clay sera relancé (pas de duplication dans HubSpot, Clay
  gère la déduplication à l'écriture selon la configuration de la table).
- Les sélecteurs utilisés pour extraire le nom affiché (fallback
  informatif envoyé à Clay, pas critique) reposent sur le DOM public de
  LinkedIn et peuvent nécessiter un ajustement si LinkedIn change sa mise en
  page ; en cas d'échec l'extension retombe sur le titre de la page.
