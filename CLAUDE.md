# CLAUDE.md

Serveur MCP GitLab en TypeScript, exécuté par Bun. Lecture seule. GitLab est appelé avec un PAT côté serveur ; en mode HTTP les clients MCP s'authentifient via le SSO (OIDC, client public). But : aider Claude Code à débugger les pipelines CI.

## Commandes

- `bun install` — dépendances
- `bun test` — tests (`bun:test`, aucun appel réseau externe)
- `bun run typecheck` — `tsc --noEmit`
- `GITLAB_TOKEN=... bun src/index.ts` — serveur stdio
- `MCP_TRANSPORT=http MCP_AUTH_DISABLED=true GITLAB_TOKEN=... bun src/index.ts` — serveur HTTP sans auth
- `docker build -t gitlab-mcp .` — image de déploiement (mode HTTP par défaut)

CI : `.github/workflows/build.yml` = un seul job `build` qui pousse l'image sur `ghcr.io/blumana-org/gitlab-mcp`, sur `master` et les tags uniquement. Volontairement minimal.

Toujours Bun : pas de node/npm/ts-node/jest/dotenv (Bun charge `.env` tout seul).

## Structure

- `src/index.ts` — point d'entrée : choisit le transport selon `MCP_TRANSPORT` (`stdio` | `http`)
- `src/server.ts` — `createMcpServer()` : instancie le `McpServer` et enregistre les outils
- `src/http.ts` — `Bun.serve` : `/mcp` (Streamable HTTP **stateless**, un server+transport par requête), `/health`, métadonnées RFC 9728
- `src/auth.ts` — config OIDC depuis l'env, vérification JWT (`jose`, JWKS découvert), métadonnées de ressource protégée
- `src/gitlab.ts` — client REST v4 minimal (`fetch` + header `PRIVATE-TOKEN`), pagination via headers `x-*`, helpers de log (`cleanLog`, `tail`)
- `src/tools.ts` — déclaration des outils MCP (`registerTool` + schémas zod) et projections « slim »
- `src/*.test.ts` — tests ; `tools.test.ts` appelle les outils via un client MCP en mémoire (`InMemoryTransport`) avec `fetch` mocké ; `http.test.ts` simule un IdP (JWKS local) et teste le flux d'auth de bout en bout

## Conventions

- **stdout est le canal MCP** : ne jamais `console.log` ; logs sur `console.error`.
- Les outils restent **read-only** (`readOnlyHint: true`). Toute action d'écriture (retry, cancel…) doit être un choix explicite et nécessitera le scope `api`.
- Les réponses sont du JSON texte. Les listes passent par des projections `slim*` pour économiser des tokens ; les `get_*` renvoient l'objet GitLab complet.
- Paginer via `GitLabClient.getPage` et renvoyer `{ items, pagination }`.
- Les paramètres tableau sont sérialisés au format Rails (`scope[]=a&scope[]=b`) par le client.
- Encapsuler les handlers avec `safe()` pour renvoyer les erreurs GitLab en `isError` plutôt que de crasher.
- `project` = ID ou chemin complet, toujours passé par `projectPath()` (URL-encodé).

## Auth (mode HTTP)

- Le serveur est un *resource server* : il ne délivre pas de tokens, il valide ceux de l'IdP (`iss`, signature, `exp`, `aud` et/ou `azp`).
- `OIDC_AUDIENCE` ou `OIDC_CLIENT_ID` est obligatoire : sinon n'importe quel token de l'IdP serait accepté.
- Ne jamais transmettre le token utilisateur à GitLab (pas de *token passthrough*) ; GitLab utilise uniquement `GITLAB_TOKEN`.
- Le `AuthInfo` validé est passé à `transport.handleRequest(req, { authInfo })` et accessible dans les handlers via `extra.authInfo`.

## Ajouter un outil

1. Endpoint dans la doc API GitLab v4.
2. `server.registerTool(...)` dans `src/tools.ts` avec un schéma zod décrit (les descriptions sont lues par le modèle).
3. Test du comportement client si nouvelle logique dans `gitlab.ts`.
4. Mettre à jour le tableau des outils du README.
