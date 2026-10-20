# Vendored crates

## xattr 0.2.3 (patched)

`gpui` 0.2.2 depends (via `gpui_http_client` → `zed-async-tar`) on `xattr ^0.2`. Current `libc`
releases no longer export `ENOATTR` on Linux, where it has always been an alias of `ENODATA`, so the
published crate fails to compile. The only change is in `src/sys/mod.rs`: on Linux/Android `ENOATTR`
is defined as `libc::ENODATA`. It is wired in with `[patch.crates-io]` in `native/Cargo.toml`.
Remove the patch once an upstream release no longer needs it.
