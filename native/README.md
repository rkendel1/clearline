# Clearline native client (Rust + GPUI)

The primary Clearline user interface: a native desktop application built with [GPUI](https://gpui.rs) (the UI framework behind the Zed editor) and [gpui-component](https://crates.io/crates/gpui-component). It talks to the existing Clearline API over HTTP and holds no business rules: what a role may see, what a query may do and what is redacted are decided by the server for every request.

```
native/
  Cargo.toml                    workspace (gpui 0.2.2, gpui-component 0.5.1), [patch] for vendor/xattr
  crates/clearline-client/      no UI dependencies
    src/api.rs                  blocking HTTP client and error model (called from background threads only)
    src/types.rs                typed API contracts (mirrors docs/api.md)
    src/session.rs              sign-in, permissions, session lifecycle (token held in memory only)
    src/format.rs               presentation-only formatting
    tests/backend.rs            contract test against a live backend, for every role
  crates/clearline-desktop/     the application (binary "clearline")
    src/main.rs                 arguments, window, SQL grammar registration
    src/app.rs                  shell: navigation rail, routing, session expiry, theme
    src/data.rs                 background loading; replacing a load cancels the previous one
    src/grid.rs                 virtualized result grid (query results, records, audit)
    src/theme.rs, src/ui.rs     Clearline palette (light/dark) and shared primitives
    src/views/                  overview, batch, exceptions, records, lineage, query, history, fields, contracts, metrics, audit, signin
    src/automation.rs           --automation: JSON commands on stdin for end-to-end tests and measurements
    src/perf.rs                 startup, render and frame-interval measurements
  vendor/xattr/                 one-line compatibility patch (see vendor/README.md)
```

## Supported targets and prerequisites

| | Linux (x86_64, aarch64) | macOS 13+ | Windows |
|---|---|---|---|
| Status | Built, tested and measured in this repository (X11; Wayland is supported by GPUI) | Supported by GPUI (Metal); not built in this repository's CI | GPUI support is experimental; not built here |

- **Rust** 1.88 or newer (`rustup`, tested with 1.97).
- **Linux system libraries** (Debian/Ubuntu): `sudo apt-get install build-essential pkg-config libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev libvulkan-dev libx11-xcb-dev libxcb1-dev libfontconfig-dev libfreetype-dev libasound2-dev libzstd-dev`
- **A Vulkan driver.** Any GPU driver works; without a GPU, Mesa's software rasterizer (`mesa-vulkan-drivers`, "lavapipe"/llvmpipe) is enough — the tests and measurements here run on it.
- A running Clearline API (Docker Compose or `npm run dev:api`, see the top-level README).

## Build and run

```sh
npm run native:build                        # = cargo build --release --manifest-path native/Cargo.toml
native/target/release/clearline --url http://localhost:8080
# or: npm run native:run -- --url http://localhost:8080 --theme dark
```

Sign in with an API token (the seeded demo tokens are in the README). Options: `--url` (or `CLEARLINE_URL`), `--theme light|dark` (or `CLEARLINE_THEME`), `--size WxH`, `--automation`. `CLEARLINE_TOKEN` signs in at startup for development; typing the token is preferable so it never sits in the environment.

Headless (CI, containers): `Xvfb :99 -screen 0 1440x940x24 & openbox & DISPLAY=:99 native/target/release/clearline …` with `mesa-vulkan-drivers` installed.

## Behaviour

- **Views offered follow the token's permissions** (`/api/v1/me`); a reporter has no record-level views, an approver sees only Contracts, a platform administrator sees no tenant data. The server enforces every request regardless.
- **Never blocks the UI thread.** Every API call runs on GPUI's background executor; views show loading, empty, error and permission-denied states. Starting a load replaces (cancels) the previous one, so there are no redundant concurrent requests or out-of-order results. A `401` from any request ends the session and returns to sign-in with the reason; an unreachable backend shows a retryable error.
- **Large results** are held once behind an `Arc` and rendered by gpui-component's virtualized table, which lays out only visible rows and formats cells lazily; sorting reorders an index. Results are capped by the server (5,000 rows by default).
- **Query workspace.** Natural-language editor; SQL proposal editor with tree-sitter SQL highlighting; the server's validation decision, structural summary (authoritative) and the model's explanation (labelled unverified); referenced columns with the role's access and their use; the exact SQL that will run; explicit Preview / Run; Cancel while running (the client names the execution so it can cancel it); CSV export; copy row. Edited SQL must be re-validated as a new proposal before it can run. Redacted columns are labelled; their values arrive redacted from the server.
- **Field policies** (stewards and administrators): sensitivity, redaction style, roles that may see original values, per-role access, the effective result for every role, and the change history. The server decides whether a change is allowed (stewards may only tighten). After a change the client clears results computed under the old policy and re-reads catalog, records and history.

## Tests

```sh
npm run native:test                          # client unit tests (format, errors, ids)
npm run test:e2e                             # needs the release (or debug) build: launches the binary under X (Xvfb if DISPLAY is unset)
```

`test/e2e/native.test.ts` starts the real API, database and worker, loads the reference dataset, launches the binary with `--automation`, and drives it through the same view methods the buttons and inputs use. It verifies the overview against ground truth for both tenants (formerly the browser dashboard test), the role-specific navigation, Scenario O (NL query → proposal → edit → run, restricted fields, an administrator's sensitivity change, redaction in the workspace, records and lineage), runs the Rust contract test against the live API, and records the measurements below. Screenshots of the real window are written to `test-results/native/`.

## Measurements

Repeatable with `npm run test:e2e` (written to `test-results/native-perf.json`; reported in [docs/benchmark.md](../docs/benchmark.md)). They are taken from `on_next_frame`, i.e. after GPUI has drawn a frame. On a machine without a GPU (Mesa lavapipe, software Vulkan) frame intervals are dominated by rasterization and scale with window area; they are pessimistic for a desktop with a GPU.
