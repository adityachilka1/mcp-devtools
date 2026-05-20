# Changelog

All notable changes to `mcp-devtools` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.1.0 — 2026-05-20

Initial release.

### Added
- Transparent stdio proxy (`mcp-devtools proxy`).
- Session recording to `.mcptrace` files (`mcp-devtools record`).
- Trace viewer (`mcp-devtools open <file>`).
- Embed API: `import { devtools } from "mcp-devtools/embed"`.
- Browser UI with live timeline, direction-tagged frames, and detail view.
- Cross-platform support (macOS, Linux, Windows; Node 20 and 22).
