# Clearline web interface

A single-page app (React 18, Vite, TypeScript) that mirrors the native desktop client view for view: overview and reports, batches, exceptions and quarantine resolution, records, lineage, extracts, the query workspace and history, saved queries (versions, parameters, schedules with a DST-aware preview, analysis builder), run history and run detail (insights, anomaly/forecast charts, outliers, clusters, deliveries), notifications, delivery destinations, contracts and migrations, metric definitions, field policies, audit trail and API tokens. Platform administrators get a Platform page (create tenants, issue first tokens).

It adds no business rules. Every request goes to the same `/api/v1` routes and the server authorizes each one; the nav only hides what the token's permissions (`/api/v1/me`) cannot use.

## Run it

- **Docker:** `docker compose up -d`, then open <http://localhost:8080>. The API image builds `web/` and serves it from the same origin (`WEB_DIR`, default `web/dist`), so there is no CORS.
- **Development:** `npm install && npm run dev` in `web/` (port 5173, proxies `/api` to `CLEARLINE_URL`, default `http://localhost:8080`).
- **Checks:** `npm run build` (typecheck + production build). Server-side hosting is covered by `test/unit/web-hosting.test.ts`.

## Security

- The bearer token is held in memory only: no cookies, no storage, never in a URL. Reloading or closing the tab signs out, as in the native client. A 401 signs out with a notice.
- The UI is served with `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'` and no inline script or style. API responses keep the stricter `default-src 'none'`.
- Redacted columns and fields are shown as the server sends them and marked ◐; nothing is unmasked client-side.
- Static files are served only from inside the build directory; traversal is rejected and `/api/*` never falls back to the app shell.

## Layout

`src/lib/` API client, router, data hooks · `src/ui.tsx` shared components · `src/Chart.tsx` SVG charts · `src/views/` one file per view (saved analytics: `Library`, `ScheduleEditor`, `AnalysisBuilder`, `Run`).
