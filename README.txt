StreamFlix — Build Notes (self-hosted)
======================================

WEB APP
-------
Dev:              npm run dev            (Vite dev server, port 8080)
Prod build:       npm run build          (TanStack Start SSR -> .output/)
Typecheck:        npx tsc --noEmit -p tsconfig.json
Lint:             npm run lint

Production runtime:
    node .output/server/index.mjs        (Nitro node-server, PORT=3000 HOST=0.0.0.0)

Auth & data:
- Pocket ID (OIDC + PKCE) is the only login provider. Sessions are stored in
  MongoDB and sent in the HttpOnly sf_session cookie.
- MongoDB holds users, sessions, profiles, lists, history, devices, reminders,
  subtitles and Web Push subscriptions. There is no Firebase anywhere.
- Push notifications use Web Push/VAPID, not FCM. Generate keys with:
      npx web-push generate-vapid-keys

DOCKER / COOLIFY
----------------
- .github/workflows/docker-publish.yml builds and pushes
  ghcr.io/<owner>/<repo>:latest on every push to main.
- Build-time (GitHub Actions vars/secrets -> Docker build args):
      VITE_TMDB_API_KEY, VITE_SITE_URL, VITE_TURNSTILE_SITE_KEY,
      VITE_WEB_PUSH_PUBLIC_KEY
- Runtime-only (set in Coolify; never as build args):
      MONGODB_URI, MONGODB_DB, POCKET_ID_ISSUER, POCKET_ID_CLIENT_ID,
      POCKET_ID_CLIENT_SECRET, POCKET_ID_REDIRECT_URI, APP_URL,
      WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY, WEB_PUSH_SUBJECT,
      NVIDIA_API_KEY, NVIDIA_BASE_URL, NVIDIA_MODEL, CRON_SECRET,
      WAYBACK_ARCHIVE_KEY
- Deploy the GHCR image as a Docker service in Coolify and expose port 3000.
- Release reminders cron: GET /api/release-notifications-cron with
  Authorization: Bearer $CRON_SECRET. See the full table in README.md.

DESKTOP (Electron)
------------------
Dev:              npm run electron:dev
Prod:             npm run electron:build   (outputs installers to release/)
- In development the Electron shell loads http://localhost:8080.
- Override the URL anytime:  ELECTRON_START_URL=https://<your-domain>/ npx electron .

MOBILE (Capacitor / Android)
----------------------------
- capacitor.config.ts points the WebView at the deployed site.
- Native Firebase Authentication and FCM plugins were removed. Sign in through
  the Pocket ID redirect flow; push uses the browser Web Push path.
- Rebuild/sync: npm run mobile:sync ; open: npm run mobile:open ; APK: npm run mobile:build

IMPORTANT:
- The desktop/mobile shells load the LIVE site. Web changes in src/ only take
  effect after you rebuild and redeploy the web app.
- A Play Store build that only wraps a remote URL may be rejected.
