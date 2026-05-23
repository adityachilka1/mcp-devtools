# Changelog

All notable changes to `mcp-devtools` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased
- proxy: `--transport http` now works against MCP servers that speak the Streamable HTTP transport. The user-facing side stays stdio; outbound requests POST to `--upstream <url>` with `Accept: application/json, text/event-stream`, and both single-JSON and SSE responses are parsed and replayed to the local client. The `Mcp-Session-Id` server header is captured and replayed on subsequent requests. Extra headers (e.g. `Authorization`) are passed with the repeatable `--header 'Name: value'` flag. Long-lived GET SSE channel for server-initiated messages is intentionally out of scope for this slice. Closes #26.
- ui: per-call token cost attribution. New `--model <id>` and `--pricing-file <yaml>` flags on the `proxy` command annotate each `tools/call` response row with a USD estimate (chars/4 token heuristic for cloud models, wall-clock × per-second rate for local models). Session total renders in the header. Unknown models surface a muted `—` badge instead of guessing. Built-in rate table at `docs/pricing.yaml`; the env var `MCP_DEVTOOLS_PRICING` is honored as a fallback. Closes #25.
- cli: new diff subcommand compares two .mcptrace files at the JSON-RPC frame level. Frame count, direction, method, is-error flag, and full body diff with frame-indexed output. Closes #27.
- cli: new `doctor` subcommand probes an upstream MCP server for protocol compliance (9 baseline checks). Exit 0 on full pass, 1 otherwise.
- embed: new `devtools.wrap(transport)` API that works with the real `@modelcontextprotocol/sdk` Server. Properly intercepts `onMessage` assignment via getter/setter. Old `devtools.attach(server)` kept as `@deprecated`, scheduled for removal in v0.2. (#23)
- release: cross-platform single-binary builds (Linux/macOS/Windows × x64/arm64) attached to GitHub releases via Bun --compile. (#22)
- chore: fix `bin` field for npm 11 strict validation — was being silently stripped on publish.
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
