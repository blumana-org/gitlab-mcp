# CLAUDE.md

Serveur MCP « devops » (nom MCP `devops-mcp` ; repo, package et image restent `gitlab-mcp`) en TypeScript, exécuté par Bun. Lecture seule. But : aider Claude Code à débugger les pipelines CI (GitLab) et à lire les logs et métriques applicatifs (VictoriaLogs / VictoriaMetrics, optionnels : activés si `VICTORIALOGS_URL` / `VICTORIAMETRICS_URL`). En stdio, GitLab est appelé avec un PAT. En HTTP, deux modes d'auth exclusifs : **login GitLab** (`GITLAB_OAUTH_CLIENT_ID` : GitLab est l'authorization server, les outils appellent GitLab avec le token de l'utilisateur) ou **SSO OIDC** (`OIDC_ISSUER` : JWT de l'IdP, GitLab appelé avec le PAT serveur).

## Commandes

- `bun install` — dépendances
- `bun test` — tests (`bun:test`, aucun appel réseau externe)
- `bun run typecheck` — `tsc --noEmit`
- `GITLAB_TOKEN=... bun src/index.ts` — serveur stdio
- `MCP_TRANSPORT=http MCP_AUTH_DISABLED=true GITLAB_TOKEN=... bun src/index.ts` — serveur HTTP sans auth
- `MCP_TRANSPORT=http GITLAB_OAUTH_CLIENT_ID=... bun src/index.ts` — serveur HTTP, login GitLab (pas de PAT)
- `docker build -t gitlab-mcp .` — image de déploiement (mode HTTP par défaut)

CI : `.github/workflows/build.yml` = un seul job `build` qui pousse l'image sur `ghcr.io/blumana-org/gitlab-mcp`, sur `master` et les tags uniquement. Volontairement minimal.

Toujours Bun : pas de node/npm/ts-node/jest/dotenv (Bun charge `.env` tout seul).

## Structure

- `src/index.ts` — point d'entrée : choisit le transport selon `MCP_TRANSPORT` (`stdio` | `http`)
- `src/server.ts` — `createMcpServer()` : instancie le `McpServer` et enregistre les outils
- `src/http.ts` — `Bun.serve` : `/mcp` (Streamable HTTP **stateless**, un server+transport par requête), `/health`, métadonnées RFC 9728
- `src/doctor.ts` — `bun run doctor <mcp-url> [--client-id]` : rejoue le flux OAuth MCP étape par étape (découverte, login PKCE, appel authentifié)
- `src/auth.ts` — interface `AuthProvider` (commune aux deux modes), config OIDC, vérification JWT (`jose`, JWKS découvert), métadonnées de ressource protégée
- `src/dcr-shim.ts` — shim d'enregistrement dynamique (comme r2e-mcp) : copie des métadonnées de l'IdP avec `registration_endpoint` = `/oauth/register`, qui renvoie toujours le client public pré-enregistré
- `src/gitlab-oauth.ts` — login GitLab : validation des tokens via `/oauth/token/info` (+ cache), check de l'issuer au boot
- `src/gitlab.ts` — client REST v4 minimal (`fetch` + `PRIVATE-TOKEN` ou `Bearer` via `asUser()`), pagination via headers `x-*`, helpers de log (`cleanLog`, `tail`)
- `src/tools.ts` — outils GitLab (`registerTool` + schémas zod) et projections « slim »
- `src/victoria.ts` — base commune `VictoriaHttpClient` (POST form-encoded, `Bearer` optionnel, `redirect: "manual"`, erreurs oauth2-proxy explicites sur 3xx/401/403, extraction du champ `error`), lecture des env `<PREFIX>_URL/_TOKEN/_TIMEOUT_MS`, parsing des temps (`parseTime` : `now`, `-12h`/`12h` = passé, `+1h`, epoch, RFC3339) et des steps
- `src/victorialogs.ts` — client VictoriaLogs (API LogsQL `/select/logsql/*`, NDJSON tolérant aux lignes tronquées, `asUser()`)
- `src/victoriametrics.ts` — client VictoriaMetrics (API Prometheus `/api/v1/*`, déballe `{status, data}`, `asUser()`)
- `src/victoria-format.ts` — rendu texte compact des résultats logs/métriques (adapté de Plawn/victoriametrics-mcp)
- `src/tools-victorialogs.ts` / `src/tools-victoriametrics.ts` — outils correspondants, enregistrés seulement si le client est configuré
- `src/tool-utils.ts` — `safe()` / `json()` partagés par les fichiers d'outils (une string est renvoyée telle quelle)
- `tests/*.test.ts` — tests (séparés de `src/`, importent depuis `../src/`) ; `tools.test.ts` appelle les outils via un client MCP en mémoire (`InMemoryTransport`) avec `fetch` mocké ; `http.test.ts` simule un IdP (JWKS local) et `gitlab-oauth.test.ts` un GitLab (`/oauth/token/info`) pour tester les flux d'auth de bout en bout, y compris quel token part vers GitLab / VictoriaLogs / VictoriaMetrics

## Conventions

- **stdout est le canal MCP** : ne jamais `console.log` ; logs sur `console.error`.
- Les outils restent **read-only** (`readOnlyHint: true`). Toute action d'écriture (retry, cancel…) doit être un choix explicite et nécessitera le scope `api`.
- Les réponses GitLab sont du JSON texte ; les outils Victoria* renvoient du texte compact (`victoria-format.ts`), troncature toujours annoncée. Les listes passent par des projections `slim*` pour économiser des tokens ; les `get_*` renvoient l'objet GitLab complet.
- Paginer via `GitLabClient.getPage` et renvoyer `{ items, pagination }`.
- Les paramètres tableau sont sérialisés au format Rails (`scope[]=a&scope[]=b`) par le client.
- Encapsuler les handlers avec `safe(name, fn)` (log une ligne `[tool]` par appel) pour renvoyer les erreurs GitLab / Victoria* en `isError` plutôt que de crasher.
- `project` = ID ou chemin complet, toujours passé par `projectPath()` (URL-encodé).

## Auth (mode HTTP)

- Le serveur est un *resource server* : il ne délivre pas de tokens, il valide ceux de l'authorization server.
- OIDC : JWT vérifié localement (`iss`, signature, `exp`, `aud` et/ou `azp`). `OIDC_ISSUER` est comparé **tel quel** au claim `iss` (ne pas normaliser le `/` final). `OIDC_AUDIENCE` ou `OIDC_CLIENT_ID` est obligatoire : sinon n'importe quel token de l'IdP serait accepté.
- Login GitLab : tokens opaques, validés par `/oauth/token/info`. Le check `application.uid == GITLAB_OAUTH_CLIENT_ID` est **indispensable** : c'est lui qui empêche d'accepter un PAT ou le token d'une autre app (et des clients enregistrés dynamiquement). GitLab injoignable pendant la validation = 503 (`AuthUnavailableError`), jamais 401.
- Logs toujours actifs : check GitLab au boot, une ligne `[http]` par requête `/mcp`, une ligne `[tool]` par appel. Les appels GitLab ont un timeout (`GITLAB_TIMEOUT_MS`).
- Les rejets sont toujours loggés (raison + claims attendus/reçus, jamais le token) ; `MCP_DEBUG=true` logue aussi les succès.
- Token utilisateur vers GitLab : **uniquement** en login GitLab, après validation de l'application (`gitlab.asUser`). En mode OIDC, ne jamais transmettre le token de l'IdP à GitLab ; GitLab utilise `GITLAB_TOKEN`. En login GitLab, `GITLAB_TOKEN` est ignoré.
- Token utilisateur vers VictoriaLogs / VictoriaMetrics : **uniquement** en OIDC, après vérification locale du JWT (`asUser` dans `http.ts`), et uniquement vers `VICTORIALOGS_URL` / `VICTORIAMETRICS_URL` (oauth2-proxy du même realm). Les `*_TOKEN` sont alors ignorés. En login GitLab / sans auth : `VICTORIALOGS_TOKEN` / `VICTORIAMETRICS_TOKEN` ou rien, jamais le token GitLab de l'utilisateur.
- Shim DCR : actif si le provider a un client public (`OIDC_CLIENT_ID` / `GITLAB_OAUTH_CLIENT_ID`) et `MCP_DCR_SHIM` ≠ `false`. Les métadonnées de ressource annoncent alors le serveur comme authorization server ; la copie des métadonnées garde l'`issuer` et les endpoints de l'IdP. `/oauth/register` ne crée rien chez l'IdP et filtre les redirect URIs (`MCP_REDIRECT_URIS`). Il ne remplace **pas** le contrôle `azp` / application, qui reste strict.
- Le `AuthInfo` validé est passé à `transport.handleRequest(req, { authInfo })` et accessible dans les handlers via `extra.authInfo`.

## Ajouter un outil

1. Endpoint dans la doc API GitLab v4 (ou API HTTP VictoriaLogs / Prometheus de VictoriaMetrics).
2. `server.registerTool(...)` dans `src/tools.ts` (ou `src/tools-victorialogs.ts` / `src/tools-victoriametrics.ts`) avec un schéma zod décrit (les descriptions sont lues par le modèle).
3. Test du comportement client si nouvelle logique dans `gitlab.ts` / `victoria*.ts`.
4. Mettre à jour le tableau des outils du README.
