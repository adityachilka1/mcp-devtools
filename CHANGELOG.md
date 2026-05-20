# Changelog

All notable changes to `mcp-devtools` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased
- npm: package published as `@adityachilka/mcp-devtools` (scoped) — npm's similarity check blocked the unscoped name. The CLI command, binary, and GitHub repo stay `mcp-devtools`.
- cli: `--quiet` flag on `proxy`, `record`, and `open` suppresses informational logs while preserving warnings and errors. (#11)
- ui: color-coded timeline rows by classification (#12), 'Copy as JSON' button in detail view (#13), live filter input at top of timeline (#24).
- ci: Bun runtime smoke job added (informational, continues-on-error pending v0.2 promise).
- cli: validate `--port` in `proxy` and `open` with clear range errors.

## 0.1.0 — 2026-05-20

Initial release.

### Added
- Transparent stdio proxy (`mcp-devtools proxy`).
- Session recording to `.mcptrace` files (`mcp-devtools record`).
- Trace viewer (`mcp-devtools open <file>`).
- Embed API: `import { devtools } from "mcp-devtools/embed"`.
- Browser UI with live timeline, direction-tagged frames, and detail view.
- Cross-platform support (macOS, Linux, Windows; Node 20 and 22).
