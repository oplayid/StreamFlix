# StreamFlix

A self-hostable, Netflix-style streaming web app. Browse movies and TV shows, manage profiles, keep a watchlist, resume playback, add your own subtitles, and get release reminders — all backed by **MongoDB** and **Pocket ID** (OIDC). There is **no Firebase** in this build.

Playback still uses external embed players. Subtitles are a separate overlay/source layer, so changing subtitles never changes the video source.

## Features

- **Pocket ID login** — single OIDC provider with PKCE; sessions live in MongoDB in an HttpOnly `sf_session` cookie.
- **MongoDB data** — profiles, favorites, continue watching, history, devices, reminders, subtitles, and push subscriptions.
- **Profiles** — multiple profiles per account, avatars, kids mode, and optional PINs.
- **Browse & explore** — home feed, trending, TV, new releases, genre/mood pages, search with filters.
- **Watch** — embed player with season/episode picker, PiP, mobile controls.
- **Custom subtitles** — upload `.vtt`/`.srt` files or add a third-party subtitle URL; VTT is normalized server-side; works as native `<track>` for direct video and as an overlay for embeds. Per-title timing offset (±5s) is remembered locally.
- **Web Push** — release-day reminders and admin broadcasts via VAPID (no FCM).
- **AI assistant** — optional NVIDIA NIM-backed recommendations and summaries.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | TanStack Start (SSR) + TanStack Router |
| UI | React 19, Tailwind CSS 4, shadcn/ui-style components, Lucide |
| Build/runtime | Vite 7, TypeScript 5, Nitro `node-server` preset |
| Auth | Pocket ID (OIDC + PKCE), `jose` for ID-token verification |
| Database | MongoDB (`mongodb` driver) |
| Push | `web-push` (VAPID) + service worker |
| Content API | TMDB |
| Hosting | Docker image (GHCR) deployed on Coolify |

## How auth works

1. `/api/auth/login` creates an OIDC state + PKCE verifier (stored in a short-lived cookie and MongoDB), then redirects to Pocket ID.
2. Pocket ID redirects back to `/api/auth/callback`; the code is exchanged for tokens, the ID token is verified against Pocket ID's JWKS, and the user is upserted into the `users` collection.
3. A 30-day session document is created in `auth_sessions` and its ID is set in the HttpOnly `sf_session` cookie.
4. All data server functions call `requireUser()`, which reads that cookie. Password management stays in Pocket ID.

## Local development

```bash
npm install
cp .env.example .env      # fill in the values below
npm run dev               # http://localhost:8080
```

Useful checks:

```bash
npx tsc --noEmit          # type check
npm run build             # production build -> .output/
npm run lint
```

The production server entry is `.output/server/index.mjs` (Nitro `node-server`).

## Environment variables

`VITE_*` values are **baked into the client bundle at build time**. Everything else is **runtime-only** and must be supplied to the container (never as Docker build args). Never commit real secrets.

### Build-time (GitHub Actions secrets/variables → Docker build args)

| Variable | Description |
| --- | --- |
| `VITE_TMDB_API_KEY` | TMDB API key used by the browser-facing data helpers. Set as Actions secret `TMDB_API_KEY` or variable `VITE_TMDB_API_KEY`. |
| `VITE_SITE_URL` | Public site URL, e.g. `https://streamflix.example.com`. |
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key (optional). |
| `VITE_WEB_PUSH_PUBLIC_KEY` | VAPID **public** key. Required for browser push subscription. |

### Runtime (Coolify environment variables)

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | yes | MongoDB connection string. Never log or commit it. |
| `MONGODB_DB` | no | Database name; defaults to the one in `MONGODB_URI`. |
| `POCKET_ID_ISSUER` (or `POCKET_ID_URL`) | yes | Base URL of your Pocket ID instance, e.g. `https://pocketid.example.com`. |
| `POCKET_ID_CLIENT_ID` | yes | OIDC client ID registered in Pocket ID. |
| `POCKET_ID_CLIENT_SECRET` | no | Client secret (only needed for confidential clients). |
| `POCKET_ID_REDIRECT_URI` | no | Defaults to `${APP_URL}/api/auth/callback`. Must exactly match the redirect URI in Pocket ID. |
| `APP_URL` | yes | Public URL of this app; used for cookies/redirects/notification links. |
| `WEB_PUSH_PUBLIC_KEY` | no | VAPID public key (falls back to `VITE_WEB_PUSH_PUBLIC_KEY`). |
| `WEB_PUSH_PRIVATE_KEY` | for push | VAPID private key. Runtime-only. |
| `WEB_PUSH_SUBJECT` | for push | `mailto:you@example.com` contact used by VAPID. |
| `NVIDIA_API_KEY` (or `NVIDIA_NIM_API_KEY`) | no | Enables the AI assistant. |
| `NVIDIA_BASE_URL` | no | Defaults to `https://integrate.api.nvidia.com/v1`. |
| `NVIDIA_MODEL` | no | Defaults to `nvidia/nemotron-3-ultra-550b-a55b`. |
| `TURNSTILE_SECRET_KEY` | no | Turnstile server verification. |
| `CRON_SECRET` | for cron | Bearer token for the release-notifications cron endpoint. |
| `WAYBACK_ARCHIVE_KEY` | no | `x-archive-key` for `/api/archive`. |
| `PORT` | no | Defaults to `3000`. |
| `HOST` | no | Defaults to `0.0.0.0`. |

Generate VAPID keys once with:

```bash
npx web-push generate-vapid-keys
```

Put the public key in both `VITE_WEB_PUSH_PUBLIC_KEY` (build arg) and `WEB_PUSH_PUBLIC_KEY` (runtime), and the private key **only** in `WEB_PUSH_PRIVATE_KEY` at runtime.

## Pocket ID setup

1. Create an OIDC client in Pocket ID.
2. Redirect URI: `https://<your-streamflix-domain>/api/auth/callback` (or the value of `POCKET_ID_REDIRECT_URI`).
3. Copy the issuer URL, client ID, and (if confidential) client secret into Coolify.
4. Make sure Pocket ID is reachable from the StreamFlix container — the server fetches `/.well-known/openid-configuration` and the JWKS at login time.

## Docker / GitHub Actions / Coolify

1. Push to `main`. `.github/workflows/docker-publish.yml` builds and pushes `ghcr.io/<owner>/<repo>:latest` (plus a short-SHA tag) using `GITHUB_TOKEN`.
2. Configure the Actions **Variables** (public): `VITE_SITE_URL`, `VITE_TURNSTILE_SITE_KEY`, `VITE_WEB_PUSH_PUBLIC_KEY`.
3. Configure the Actions **Secrets**: `TMDB_API_KEY` (falls back to variable `VITE_TMDB_API_KEY`).
4. In Coolify, create a new **Docker Image** service pointing at `ghcr.io/<owner>/<repo>:latest`. If the image is private, add a registry token with `read:packages`.
5. Set all runtime variables from the table above in Coolify, then deploy.
6. Health-check: `GET /api/auth/me` returns `{"user":null}` when logged out and the user object when logged in.

The Dockerfile is multi-stage: dependencies are installed with `npm ci`, Vite builds with the `VITE_*` args, and the final image contains only `.output`, `node_modules`, and `package.json`, running:

```bash
node .output/server/index.mjs
```

### Scheduled reminders

`/api/release-notifications-cron` requires `Authorization: Bearer $CRON_SECRET` (also accepts the legacy Vercel cron headers). Keep the existing GitHub Actions workflow (`.github/workflows/release-notifications.yml`) and set the `CRON_SECRET` secret plus the `SITE_URL` variable, or point any external scheduler at that endpoint.

## Subtitles

Subtitles are stored per media id (`<tmdbId>` or `tv-<tmdbId>`) in the `subtitles` collection. Uploaded/URL subtitles are fetched and normalized to WebVTT on the server, then served from `/api/subtitles/<id>` with `text/vtt`. On the watch page, open Settings → Subtitles to add/remove tracks or adjust timing. Owners may remove their own tracks; everyone can use any track for that title.

Third-party embed players don't expose playback time. When an embed cannot report progress, the watch page shows a small **Subtitle clock** — start it when the movie starts and use the ±5s timing offset to line cues up. Direct video sources use native `<track>` elements and need no manual clock.

## Desktop & mobile

The Electron desktop build and Capacitor Android wrapper still load the deployed site. Native Firebase authentication and FCM were removed; use the Pocket ID flow and Web Push in the wrapper. Web changes only appear in those shells after redeploying the web app.

## License

[MIT](LICENSE)
