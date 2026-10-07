# gitlab-mcp

Serveur MCP minimaliste (TypeScript + Bun) pour GitLab.
Objectif : permettre à Claude Code d'inspecter et de débugger les pipelines CI.

- Accès GitLab via un **Personal Access Token** côté serveur (scope `read_api`).
- Deux modes : **stdio** (local) ou **HTTP** (déployé, Docker), protégé par le **SSO de l'entreprise** (OIDC, client public + PKCE).

## Outils

| Outil             | Description                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `search_projects` | Recherche de projets par nom/chemin (paginé)                                |
| `list_pipelines`  | Pipelines d'un projet, plus récents d'abord ; filtres `ref`, `status`, `source`, `sha` (paginé) |
| `get_pipeline`    | Détail d'un pipeline                                                        |
| `list_jobs`       | Jobs d'un projet ou d'un pipeline (`pipeline_id`) ; filtre `scope` (ex. `["failed"]`) (paginé) |
| `get_job`         | Détail d'un job ; `include_log: true` ajoute la fin du log (ANSI nettoyé, `log_tail_lines` = 200 par défaut) |

Le paramètre `project` accepte un ID numérique ou un chemin complet (`group/sub/project`).
Les outils paginés renvoient `{ items, pagination: { page, per_page, next_page, prev_page, total, total_pages } }`.

## Configuration

Voir [`.env.example`](.env.example).

| Variable            | Mode  | Défaut                   | Description |
| ------------------- | ----- | ------------------------ | ----------- |
| `GITLAB_TOKEN`      | tous  | — (requis)               | PAT GitLab, scope `read_api` |
| `GITLAB_URL`        | tous  | `https://gitlab.com`     | Instance GitLab |
| `MCP_TRANSPORT`     | tous  | `stdio` (`http` en Docker) | `stdio` ou `http` |
| `PORT`              | http  | `3000`                   | Port d'écoute |
| `MCP_PUBLIC_URL`    | http  | `http://localhost:$PORT` | URL publique (sert d'identifiant de ressource OAuth) |
| `OIDC_ISSUER`       | http  | — (requis)               | Issuer OIDC du SSO |
| `OIDC_CLIENT_ID`    | http  | —                        | Client public ; vérifié contre le claim `azp`/`client_id` |
| `OIDC_AUDIENCE`     | http  | —                        | `aud` attendu (au moins un de `OIDC_CLIENT_ID` / `OIDC_AUDIENCE`) |
| `OIDC_SCOPES`       | http  | `openid profile email`   | Scopes annoncés au client MCP |
| `OIDC_JWKS_URI`     | http  | découvert                | Override de l'URI JWKS |
| `MCP_AUTH_DISABLED` | http  | `false`                  | `true` = pas d'auth (dev local uniquement) |

## Usage local (stdio)

```sh
bun install
claude mcp add gitlab -e GITLAB_TOKEN=glpat-xxx -- bun "$PWD/src/index.ts"
```

## Déploiement (Docker, HTTP + SSO)

```sh
docker run -d -p 3000:3000 --env-file .env ghcr.io/blumana-org/gitlab-mcp:latest
# ou en local : docker build -t gitlab-mcp .
```

L'image est construite par GitHub Actions (`.github/workflows/build.yml`) et poussée sur GitHub Container Registry :
`ghcr.io/blumana-org/gitlab-mcp:sha-<sha court>` à chaque build, `:latest` sur `master`, `:<tag>` sur les tags git.

- Endpoint MCP : `POST $MCP_PUBLIC_URL/mcp` (Streamable HTTP, stateless → scalable horizontalement)
- Healthcheck : `GET /health`
- Métadonnées OAuth : `GET /.well-known/oauth-protected-resource[/mcp]`
- À mettre derrière un reverse proxy TLS ; `MCP_PUBLIC_URL` doit être l'URL HTTPS publique.

### Fonctionnement de l'auth

Le serveur est un *resource server* OAuth au sens de la spec MCP :

1. Le client MCP (Claude Code) appelle `/mcp` sans token → `401` avec `WWW-Authenticate: Bearer resource_metadata=...`.
2. Il lit les métadonnées (RFC 9728) qui pointent vers `OIDC_ISSUER`, découvre l'IdP et lance un flow *authorization code + PKCE* avec le client public.
3. Il rappelle `/mcp` avec l'access token ; le serveur vérifie la signature (JWKS), l'`iss`, l'`exp`, et l'`aud` et/ou le `azp`.

Les appels GitLab utilisent ensuite le PAT du serveur (pas le token de l'utilisateur).

### Côté IdP

Créer un **client public** (pas de secret, PKCE S256) :

- Redirect URI : `http://localhost:<port>/callback` (le port est celui passé à `--callback-port`)
- Les access tokens doivent être des **JWT** (Keycloak, Okta, Entra ID, Auth0… oui ; les access tokens Google sont opaques et ne sont pas supportés).
- Keycloak : `azp` vaut le client ID par défaut → `OIDC_CLIENT_ID` suffit. Pour vérifier `aud`, ajouter un *audience mapper* et définir `OIDC_AUDIENCE`.

### Ajout à Claude Code

```sh
claude mcp add --transport http gitlab https://gitlab-mcp.example.com/mcp \
  --client-id gitlab-mcp --callback-port 8765
```

Puis `/mcp` dans Claude Code → *Authenticate* : le navigateur s'ouvre sur le SSO.

## Workflow de debug typique

1. `search_projects` → récupérer le chemin du projet
2. `list_pipelines` avec `status: "failed"` (et `ref` si besoin)
3. `list_jobs` avec `pipeline_id` et `scope: ["failed"]`
4. `get_job` avec `include_log: true` pour lire l'erreur

## Développement

```sh
bun test            # tests unitaires + intégration HTTP/auth (IdP simulé)
bun run typecheck   # tsc --noEmit
bun run start       # serveur stdio
MCP_TRANSPORT=http MCP_AUTH_DISABLED=true bun run start   # serveur HTTP sans auth
bunx @modelcontextprotocol/inspector bun src/index.ts     # tester à la main
```
