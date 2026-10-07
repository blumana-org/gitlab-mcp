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
| `list_registry_repositories` | Images Docker du registry du projet, avec leur nombre de tags (paginé) |
| `list_registry_tags` | Tags d'une image ; `include_details: true` ajoute digest, taille et date (paginé) |

Le paramètre `project` accepte un ID numérique ou un chemin complet (`group/sub/project`).
Les outils paginés renvoient `{ items, pagination: { page, per_page, next_page, prev_page, total, total_pages } }`.

## Configuration

Voir [`.env.example`](.env.example).

| Variable            | Mode  | Défaut                   | Description |
| ------------------- | ----- | ------------------------ | ----------- |
| `GITLAB_TOKEN`      | tous  | — (requis)               | PAT GitLab, scope `read_api` |
| `GITLAB_URL`        | tous  | `https://gitlab.com`     | Instance GitLab |
| `GITLAB_TIMEOUT_MS` | tous  | `20000`                  | Timeout des appels GitLab |
| `MCP_TRANSPORT`     | tous  | `stdio` (`http` en Docker) | `stdio` ou `http` |
| `PORT`              | http  | `3000`                   | Port d'écoute |
| `MCP_PUBLIC_URL`    | http  | `http://localhost:$PORT` | URL publique (sert d'identifiant de ressource OAuth) |
| `OIDC_ISSUER`       | http  | — (requis)               | Issuer OIDC du SSO |
| `OIDC_CLIENT_ID`    | http  | —                        | Client public ; vérifié contre le claim `azp`/`client_id` |
| `OIDC_AUDIENCE`     | http  | —                        | `aud` attendu (au moins un de `OIDC_CLIENT_ID` / `OIDC_AUDIENCE`) |
| `OIDC_SCOPES`       | http  | `openid profile email`   | Scopes annoncés au client MCP |
| `OIDC_JWKS_URI`     | http  | découvert                | Override de l'URI JWKS |
| `MCP_AUTH_DISABLED` | http  | `false`                  | `true` = pas d'auth (dev local uniquement) |
| `MCP_DEBUG`         | http  | `false`                  | `true` = log chaque étape d'auth (pas seulement les rejets) |

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

L'image est construite par GitHub Actions (`.github/workflows/build.yml`) et poussée sur GitHub Container Registry (multi-arch `linux/amd64` + `linux/arm64`) :
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

### Débugger l'OAuth

Quand l'auth échoue dans Claude Code, isoler l'étape fautive :

1. **Rejouer le flux avec le doctor** (depuis ton poste) :
   ```sh
   bun run doctor https://gitlab-mcp.example.com/mcp                                   # découverte seule
   bun run doctor https://gitlab-mcp.example.com/mcp --client-id gitlab-mcp --callback-port 8765   # + vrai login
   ```
   Il vérifie dans l'ordre : le 401 + `resource_metadata`, les métadonnées de ressource, la découverte de l'IdP (issuer, PKCE S256), le login, l'échange de code, puis un appel MCP authentifié avec le token obtenu. Le premier ✗ indique le problème.
2. **Logs serveur** : au démarrage, `GitLab OK ... as <user>` ou `GitLab check FAILED: ...` ; puis une ligne par requête `/mcp` (`[http] POST /mcp 200 12ms`) et par appel d'outil (`[tool] get_job ok 230ms` / `error ...`). Aucune ligne `[http]` = la requête n'atteint pas le conteneur. tout rejet de token est loggé avec la raison et la comparaison attendu / reçu (`iss`, `aud`, `azp`, `exp`), sans le token. `MCP_DEBUG=true` logue aussi les étapes réussies et les 404. La raison est aussi renvoyée dans le `WWW-Authenticate` du 401.
3. **Logs Claude Code** : `claude --debug` (ou `--debug-file /tmp/claude.log`), puis `/mcp` → *Authenticate*.

Causes fréquentes :

| Symptôme | Cause probable |
| --- | --- |
| Pas de `resource_metadata` dans le 401 | Un reverse proxy supprime le header `WWW-Authenticate` |
| `resource` différent de l'URL utilisée | `MCP_PUBLIC_URL` incorrect |
| `issuer` ne correspond pas | `OIDC_ISSUER` doit être identique au champ `issuer` de l'IdP (y compris le `/` final) |
| L'IdP renvoie `redirect_uri` invalide | Redirect URI `http://localhost:<callback-port>/callback` non autorisée sur le client |
| L'IdP refuse le paramètre `resource` (Entra ID) | Tester avec `--no-resource` |
| L'échange de code demande un secret | Le client n'est pas configuré en *public* |
| `Token was not issued to client` / `unexpected "aud"` | `OIDC_CLIENT_ID` / `OIDC_AUDIENCE` ne correspondent pas aux claims (voir le log serveur) |
| `not a JWT (opaque token?)` | L'IdP émet des access tokens opaques : non supporté |

## Workflow de debug typique

1. `search_projects` → récupérer le chemin du projet
2. `list_pipelines` avec `status: "failed"` (et `ref` si besoin)
3. `list_jobs` avec `pipeline_id` et `scope: ["failed"]`
4. `get_job` avec `include_log: true` pour lire l'erreur

## Développement

```sh
bun test            # tests unitaires + intégration HTTP/auth (IdP simulé)
bun run doctor <mcp-url> [--client-id ...]   # diagnostic du flux OAuth
bun run typecheck   # tsc --noEmit
bun run start       # serveur stdio
MCP_TRANSPORT=http MCP_AUTH_DISABLED=true bun run start   # serveur HTTP sans auth
bunx @modelcontextprotocol/inspector bun src/index.ts     # tester à la main
```
