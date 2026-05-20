# Roadmap

Living document. The dates are intentions, not commitments.

## v0.1.x — patch series (June 2026)

The polish wave that follows the initial release.

- Cross-platform install hardening (Windows path quoting in `--upstream`)
- [`--quiet`](https://github.com/adityachilka1/mcp-devtools/issues/11) flag for log suppression
- [Color-coded timeline rows](https://github.com/adityachilka1/mcp-devtools/issues/12) in the inspector
- [Copy-frame-as-JSON](https://github.com/adityachilka1/mcp-devtools/issues/13) button
- [`--port` validation](https://github.com/adityachilka1/mcp-devtools/issues/14) — ✅ shipped in #18
- [Bun runtime](https://github.com/adityachilka1/mcp-devtools/issues/15) in CI matrix
- [Asciinema demo](https://github.com/adityachilka1/mcp-devtools/issues/21) in README
- [Signed CLI binaries](https://github.com/adityachilka1/mcp-devtools/issues/22) attached to releases

## v0.2 — Streamable HTTP + replay (Q3 2026)

The first release that meaningfully expands the surface area.

- [Streamable HTTP transport](https://github.com/adityachilka1/mcp-devtools/issues/26) proxying
- [Replay with diff](https://github.com/adityachilka1/mcp-devtools/issues/27) — compare two `.mcptrace` files semantically
- Schema explorer in the UI
- [Real SDK Server adapter](https://github.com/adityachilka1/mcp-devtools/issues/23) for `embed` mode (the current adapter is structural)
- [Timeline search/filter](https://github.com/adityachilka1/mcp-devtools/issues/24)

## v0.3 — Observability backend (Q4 2026)

- OpenTelemetry export
- VS Code extension
- [Token-cost dashboard](https://github.com/adityachilka1/mcp-devtools/issues/25) across providers
- [Multi-server topology view](https://github.com/adityachilka1/mcp-devtools/issues/28)

## Not on the roadmap (explicit non-goals)

- Hosted SaaS — `mcp-devtools` stays local-first.
- An MCP client of its own — point your existing client at the proxy.
- Replacing the official `mcp-inspector` — we complement it; their tool is a single-server REPL, ours is a passive multi-tab inspector.

## How to influence the roadmap

Open an issue or 👍 an existing one. Issues with the most reactions in any given month get prioritised for the next minor.
