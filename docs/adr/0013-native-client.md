# 0013: A native Rust/GPUI client replaces the React dashboard

**Context.** The dashboard was a React/Vite single-page application served by the API. The query workspace adds long-lived sessions, large result sets, an SQL editor and continuous interaction while queries run.

**Decision.** Replace it with a native desktop application in Rust on GPUI (and gpui-component for inputs, the code editor and the virtualized table), consuming the same API. A UI-free crate holds the typed contracts and HTTP client; all I/O runs on background executors; the API no longer serves browser content.

**Reasons.** GPUI renders on the GPU with a retained-entity model, which keeps editing responsive and makes virtualized grids of thousands of rows cheap; the native client cannot be framed or scripted by another origin, and holds the token only in memory. Keeping the client free of business rules (the server decides access, redaction and validation) means replacing the UI changed no backend behaviour: Scenarios A–J are unchanged, and the former browser test's checks moved to the native end-to-end test.

**Costs.** Users install a desktop binary per platform instead of opening a URL; GPUI is pre-1.0 (pinned versions, one vendored compatibility patch); headless testing needs an X server and a Vulkan driver (software rendering works). Only Linux is built and tested here.

**Revisit when** browser access is required again: the API is unchanged, so a web client can be added without touching the backend.

**Update (ADR 0017).** A web client now exists beside the native one and the API serves its static files from the same origin, under a content security policy of its own. API responses keep `default-src 'none'`. The statements above that the API serves no browser content describe the state when this ADR was written; the native client remains the reference client for Scenarios J, O and U.
