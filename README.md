# gitlab-mcp

Serveur MCP minimaliste (TypeScript + Bun) pour le debug « devops » : GitLab CI + logs VictoriaLogs + métriques VictoriaMetrics (nom MCP : `devops-mcp`).
Objectif : permettre à Claude Code d'inspecter et de débugger les pipelines CI, puis de corréler avec les logs et métriques applicatifs.

- Deux modes : **stdio** (local, PAT) ou **HTTP** (déployé, Docker), avec au choix :
  - **login GitLab** (recommandé) : les utilisateurs se connectent avec leur compte GitLab et les outils appellent GitLab **avec leur propre token** → chacun ne voit que ce que ses droits GitLab permettent, audit GitLab nominatif, aucun PAT côté serveur ;
  - **SSO de l'entreprise** (OIDC, client public + PKCE) + **Personal Access Token** côté serveur (scope `read_api`), partagé par tous.

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
| `query_logs`      | VictoriaLogs : logs d'une requête LogsQL, une ligne par entrée, plus récents d'abord (`start` = `-1h`, `limit` = 100, message tronqué à `max_message_chars`) |
| `log_hits`        | VictoriaLogs : nombre de logs par intervalle (`step`), groupable par champ (`field`) → quand une erreur a commencé |
| `list_log_fields` | VictoriaLogs : champs présents dans les logs d'une requête |
| `list_log_field_values` | VictoriaLogs : valeurs distinctes d'un champ (apps, pods, niveaux…) |
| `query_metrics`   | VictoriaMetrics : requête PromQL/MetricsQL instantanée, une valeur par série |
| `query_metrics_range` | VictoriaMetrics : requête sur une plage (`start` = `-1h`) : min/max/moy/dernière valeur + points échantillonnés |
| `list_metric_series` | VictoriaMetrics : séries correspondant à des sélecteurs (`match`) |
| `list_metric_label_values` | VictoriaMetrics : valeurs d'un label (`__name__` = noms de métriques) |
| `list_scrape_targets` | VictoriaMetrics : santé des cibles de scrape (`only_unhealthy`) |

Les outils VictoriaLogs n'apparaissent que si `VICTORIALOGS_URL` est défini, ceux de VictoriaMetrics que si `VICTORIAMETRICS_URL` l'est.
Ils répondent en texte compact (une ligne par entrée / série, ANSI et champs Docker retirés, troncature toujours signalée) plutôt qu'en JSON.
Les paramètres de temps (`start`, `end`, `time`) acceptent `now`, une durée dans le passé (`-12h` ou `12h`, `+1h` pour le futur), un epoch en secondes ou une date RFC3339.

Le paramètre `project` accepte un ID numérique ou un chemin complet (`group/sub/project`).
Les outils paginés renvoient `{ items, pagination: { page, per_page, next_page, prev_page, total, total_pages } }`.

## Configuration

Voir [`.env.example`](.env.example).

| Variable            | Mode  | Défaut                   | Description |
| ------------------- | ----- | ------------------------ | ----------- |
| `GITLAB_TOKEN`      | stdio, http+OIDC | — (requis) | PAT GitLab, scope `read_api` (ignoré en login GitLab) |
| `GITLAB_URL`        | tous  | `https://gitlab.com`     | Instance GitLab |
| `GITLAB_OAUTH_CLIENT_ID` | http | —                   | Active le login GitLab : Application ID de l'application OAuth GitLab |
| `GITLAB_OAUTH_SCOPES` | http | `read_api`             | Scopes annoncés ; le token doit tous les porter |
| `GITLAB_OAUTH_ISSUER` | http | `GITLAB_URL`           | URL publique de GitLab si `GITLAB_URL` est une adresse interne |
| `GITLAB_TIMEOUT_MS` | tous  | `20000`                  | Timeout des appels GitLab |
| `VICTORIALOGS_URL`  | tous  | —                        | Active les outils logs : URL de VictoriaLogs (ou de l'oauth2-proxy devant) |
| `VICTORIALOGS_TOKEN` | stdio, http hors OIDC | — | Bearer statique (ignoré en OIDC : le token de l'utilisateur est transmis) |
| `VICTORIALOGS_TIMEOUT_MS` | tous | `GITLAB_TIMEOUT_MS` | Timeout des appels VictoriaLogs |
| `VICTORIAMETRICS_URL` | tous | —                       | Active les outils métriques : URL de VictoriaMetrics / vmselect (ou de l'oauth2-proxy devant) |
| `VICTORIAMETRICS_TOKEN` | stdio, http hors OIDC | — | Bearer statique (ignoré en OIDC) |
| `VICTORIAMETRICS_TIMEOUT_MS` | tous | `GITLAB_TIMEOUT_MS` | Timeout des appels VictoriaMetrics |
| `MCP_TRANSPORT`     | tous  | `stdio` (`http` en Docker) | `stdio` ou `http` |
| `PORT`              | http  | `3000`                   | Port d'écoute |
| `MCP_PUBLIC_URL`    | http  | `http://localhost:$PORT` | URL publique (sert d'identifiant de ressource OAuth) |
| `OIDC_ISSUER`       | http  | —                        | Active le SSO : issuer OIDC (exclusif avec `GITLAB_OAUTH_CLIENT_ID`) |
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

## Déploiement (Docker, HTTP)

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

### Login GitLab (recommandé)

Le serveur annonce GitLab comme *authorization server* ; le client MCP fait le flow *authorization code + PKCE* directement avec GitLab, puis appelle `/mcp` avec l'access token GitLab.

À chaque requête, le serveur demande à GitLab (`GET /oauth/token/info`, résultat mis en cache 60 s) si le token est valide, **émis pour notre application** (`application.uid == GITLAB_OAUTH_CLIENT_ID`) et porte les scopes requis. Puis les outils appellent GitLab avec ce même token. Le contrôle de l'application est ce qui rend ce relais légitime : un PAT ou un token d'une autre application GitLab est refusé. La révocation reste appliquée par GitLab à chaque appel API.

Côté GitLab (*Admin → Applications*, ou au niveau d'un groupe/utilisateur) :

- Application **non confidentielle** (pas de secret, PKCE), scope **`read_api`** uniquement
- Redirect URIs (une par ligne) : `http://localhost:<port>/callback` pour Claude Code / le doctor, `https://claude.ai/api/mcp/auth_callback` pour claude.ai
- `GITLAB_OAUTH_CLIENT_ID` = l'*Application ID*

Le client MCP **doit** utiliser cet Application ID (`--client-id`) : GitLab propose aussi l'enregistrement dynamique de clients, mais un client enregistré dynamiquement a un autre ID et ses tokens sont refusés.

```sh
claude mcp add --transport http gitlab https://gitlab-mcp.example.com/mcp \
  --client-id <application-id> --callback-port 8765
```

Les access tokens GitLab expirent au bout de 2 h ; le client MCP les rafraîchit avec le refresh token.

### SSO (OIDC) + PAT

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

### VictoriaLogs / VictoriaMetrics derrière oauth2-proxy

En mode OIDC, le serveur **transmet le token de l'utilisateur** (déjà vérifié : `iss`, signature, `exp`, `aud`/`azp`) à `VICTORIALOGS_URL` et `VICTORIAMETRICS_URL`. L'oauth2-proxy du même realm applique donc ses règles (email, groupes) par utilisateur, sans secret côté serveur. Le token n'est jamais envoyé à GitLab.

Côté oauth2-proxy :

- `--skip-jwt-bearer-tokens=true` : accepter un `Authorization: Bearer` au lieu du cookie de session ;
- `--extra-jwt-issuers=<OIDC_ISSUER>=<audience>` : l'audience doit figurer dans le claim `aud` du token. Keycloak met `aud=account` par défaut : ajouter un *audience mapper* sur le client MCP (par ex. l'audience du client oauth2-proxy) et utiliser cette valeur ;
- le token doit porter `email` (scope `email`) ; si `email_verified` est faux, `--insecure-oidc-allow-unverified-email`.

Un rejet de l'oauth2-proxy (redirection vers le login, 401, 403) remonte comme erreur d'outil explicite (`VictoriaLogs (oauth2-proxy) rejected the token…`, idem pour VictoriaMetrics).

En login GitLab, il n'y a pas de token du realm : utiliser `VICTORIALOGS_TOKEN` / `VICTORIAMETRICS_TOKEN`, ou des URLs internes sans proxy. Le token GitLab de l'utilisateur n'est jamais transmis.

### Débugger l'OAuth

Quand l'auth échoue dans Claude Code, isoler l'étape fautive :

1. **Rejouer le flux avec le doctor** (depuis ton poste) :
   ```sh
   bun run doctor https://gitlab-mcp.example.com/mcp                                   # découverte seule
   bun run doctor https://gitlab-mcp.example.com/mcp --client-id gitlab-mcp --callback-port 8765   # + vrai login
   ```
   Il vérifie dans l'ordre : le 401 + `resource_metadata`, les métadonnées de ressource, la découverte de l'authorization server (IdP ou GitLab : issuer, PKCE S256), le login, l'échange de code, puis un appel MCP authentifié avec le token obtenu. Le premier ✗ indique le problème. Fonctionne dans les deux modes (en login GitLab, `--client-id` = l'Application ID GitLab).
2. **Logs serveur** : au démarrage, `GitLab OK ... as <user>` (PAT) ou `GitLab OAuth OK ...: issuer ...` (login GitLab), sinon `... check FAILED: ...` ; puis une ligne par requête `/mcp` (`[http] POST /mcp 200 12ms`) et par appel d'outil (`[tool] get_job ok 230ms` / `error ...`). Aucune ligne `[http]` = la requête n'atteint pas le conteneur. Tout rejet de token est loggé avec la raison et la comparaison attendu / reçu (OIDC : `iss`, `aud`, `azp`, `exp` ; login GitLab : application, scopes, format du token), sans le token. Si GitLab ne répond pas pendant la validation : `[auth] cannot validate token` et un 503. `MCP_DEBUG=true` logue aussi les étapes réussies et les 404. La raison est aussi renvoyée dans le `WWW-Authenticate` du 401.
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
| `Token was not issued to GitLab application` | Login GitLab : le client a fait de l'enregistrement dynamique → lui passer `--client-id` |
| `GitLab advertises issuer ...` (au boot) | Login GitLab : `GITLAB_URL` diffère de l'URL publique de GitLab → `GITLAB_OAUTH_ISSUER` |
| `503 temporarily_unavailable` | Login GitLab : GitLab injoignable pour valider le token |

## Workflow de debug typique

1. `search_projects` → récupérer le chemin du projet
2. `list_pipelines` avec `status: "failed"` (et `ref` si besoin)
3. `list_jobs` avec `pipeline_id` et `scope: ["failed"]`
4. `get_job` avec `include_log: true` pour lire l'erreur
5. Si l'erreur vient du déploiement ou du runtime : `log_hits` pour situer le début du problème, puis `query_logs` (`list_log_field_values` pour trouver les noms d'apps / pods) ; côté métriques, `list_scrape_targets` puis `query_metrics_range` (`list_metric_label_values` avec `__name__` pour trouver les métriques)

## Développement

```sh
bun test            # tests unitaires + intégration HTTP/auth (IdP et GitLab simulés)
bun run doctor <mcp-url> [--client-id ...]   # diagnostic du flux OAuth
bun run typecheck   # tsc --noEmit
bun run start       # serveur stdio
MCP_TRANSPORT=http MCP_AUTH_DISABLED=true bun run start   # serveur HTTP sans auth
MCP_TRANSPORT=http GITLAB_OAUTH_CLIENT_ID=<app-id> bun run start   # serveur HTTP, login GitLab
bunx @modelcontextprotocol/inspector bun src/index.ts     # tester à la main
```
