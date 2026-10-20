# 0017: A web interface beside the native client, served by the API

**Context.** ADR 0013 made the native client the only user interface and the API served JSON only. Evaluating the platform then required building a Rust/GPUI client, which is a high barrier for a reader who wants to look around.

**Decision.** Add a React single-page app (`web/`) that renders the same API with the same views and permissions. The API serves the built files from its own origin (`WEB_DIR`), with a content security policy of its own (`script-src 'self'`, no inline script or style, `frame-ancestors 'none'`). API responses keep `default-src 'none'`. The bearer token lives in memory only.

**Alternatives.** A separate web-server container (one more service and a CORS or proxy layer); server-side rendering (a second runtime for the UI); a hosted front end.

**Consequences.** One image and one origin, no second source of business logic. The API process now serves static files, so the handler serves only files inside the build directory and has path-traversal tests (`test/unit/web-hosting.test.ts`). The web client is verified by a headless-browser smoke run and that unit test, not by the recorded scenario suite, and the native client remains the reference client for Scenarios J, O and U. A reload signs the user out by design.

**Revisit when** SSO, server-side rendering or a CDN is required.
