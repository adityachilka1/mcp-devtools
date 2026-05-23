<div align="center">

# mcp-devtools

**Chrome DevTools for the Model Context Protocol.**

Stop tailing logs. See every tool call your agent makes, why it failed, how long it took, and what it cost — all in a local browser window.

[![npm](https://img.shields.io/npm/v/@adityachilka/mcp-devtools?style=flat-square&color=000)](https://www.npmjs.com/package/@adityachilka/mcp-devtools)
[![license](https://img.shields.io/npm/l/@adityachilka/mcp-devtools?style=flat-square&color=000)](./LICENSE)
[![ci](https://img.shields.io/github/actions/workflow/status/adityachilka1/mcp-devtools/ci.yml?style=flat-square&label=ci&color=000)](https://github.com/adityachilka1/mcp-devtools/actions)
[![stars](https://img.shields.io/github/stars/adityachilka1/mcp-devtools?style=flat-square&color=000)](https://github.com/adityachilka1/mcp-devtools/stargazers)
[![contributors](https://img.shields.io/github/contributors/adityachilka1/mcp-devtools?style=flat-square&color=000)](https://github.com/adityachilka1/mcp-devtools/graphs/contributors)
<!-- Discord server coming soon — open an issue or Discussion for now -->


<sub>Inspect · Profile · Replay · Diff</sub>

![demo](./docs/demo.gif)

</div>

---

## Why

You're building an MCP server (or just running one) and something is off — the wrong tool fires, a call takes 14 seconds, your agent loops, your token bill triples overnight. Today's options: `console.log`, the official MCP Inspector (CLI-only, single-server), or grep through 40 MB of JSON-RPC logs.

`mcp-devtools` is the local-first inspector and profiler that should have shipped with the protocol. Point any MCP client at it instead of your real server, and watch every request and response stream into a browser UI you can search, filter, replay, and diff.

## Install

```bash
npm install -g @adityachilka/mcp-devtools
# or
pnpm add -g @adityachilka/mcp-devtools
```

## Quick start — proxy mode (recommended)

`mcp-devtools` sits between your client (Claude Desktop, Cowork, Cursor, your own agent) and your real MCP server. Zero changes to the server.

```bash
mcp-devtools proxy \
  --upstream "node ./my-mcp-server.js" \
  --port 7456
```

Then point your client at `http://localhost:7456`. Open `http://localhost:7456/inspect` in your browser.

You get:

- **Timeline** — every `initialize`, `tools/list`, `tools/call`, `resources/read`, and notification in chronological order.
- **Tool view** — for any `tools/call`, the inputs (with schema validation), the response, the latency, and the LLM-attributed token cost.
- **Schema explorer** — live view of the server's declared tools, resources, and prompts.
- **Replay** — click any past call, edit the arguments, hit run. Re-hits the upstream and shows the diff against the original response.
- **Time travel** — scrub a slider to see the protocol state at any point in the session.

## Quick start — embed mode

Already have a Node/TypeScript MCP server? Add five lines.

```ts
import { createServer } from "@modelcontextprotocol/sdk/server";
import { devtools } from "mcp-devtools/embed";

const server = createServer({ name: "my-server", version: "1.0.0" });
// ... register your tools ...

devtools.attach(server, { port: 7456 });
```

The DevTools UI is now available at `http://localhost:7456/inspect` whenever your server is running.

## Quick start — record mode

Record a session and share the trace file with a teammate or in a bug report.

```bash
mcp-devtools record --upstream "node ./my-mcp-server.js" --out session.mcptrace
mcp-devtools open session.mcptrace      # opens the UI on the recorded trace
```

`.mcptrace` files are gzipped JSONL — diffable, grep-able, and small.

## Quick start — profile mode

Recorded a session and want to know where the time went? `profile` reports per-method p50/p95/p99 latency and the slowest individual calls — Chrome DevTools Performance tab, for MCP.

```bash
mcp-devtools profile session.mcptrace
mcp-devtools profile session.mcptrace --json | jq .
```

## Features

| | |
|---|---|
| Live request/response timeline | Schema visualizer (tools, resources, prompts) |
| Per-tool latency histograms | Token attribution (per call, per session) |
| Error grouping and stack traces | Replay any call with modified args |
| Time-travel slider | Diff between two recorded sessions |
| Works with stdio AND streamable HTTP | Browser-only — no telemetry, nothing leaves your machine |
| Export `.mcptrace` files | Open-source, MIT, self-hostable |

## Architecture

```
┌────────────────┐   stdio/http     ┌──────────────────┐   stdio/http   ┌─────────────────┐
│   MCP client   │ ────────────────▶│   mcp-devtools   │ ──────────────▶│   upstream MCP  │
│ (Claude, etc.) │                  │   proxy + UI     │                │   server        │
└────────────────┘ ◀────────────────└──────────────────┘ ◀──────────────└─────────────────┘
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │  local browser   │
                                   │  http://:7456    │
                                   └──────────────────┘
```

Single binary. No daemon. No cloud. No login.

## Integration guides

Step-by-step setup for popular MCP clients:

- [Claude Desktop](./docs/integrations/claude-desktop.md)
- [Cursor](./docs/integrations/cursor.md)
- [Cline (VS Code)](./docs/integrations/cline.md)

All three follow the same wrapper pattern — point your client at `mcp-devtools proxy` instead of your real server, and the inspector picks up everything.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full picture. The short version:

- [x] **v0.1** — stdio proxy, recorder, embed API, browser UI
- [ ] **v0.1.x** — `--quiet`, color-coded timeline, signed binaries, Bun support
- [ ] **v0.2** — streamable HTTP transport, replay with diff, schema explorer
- [ ] **v0.3** — OpenTelemetry export, VS Code extension, cost dashboard

## Contributing

We love contributions — see [CONTRIBUTING.md](./CONTRIBUTING.md). Good first issues are labeled [`good-first-issue`](https://github.com/adityachilka1/mcp-devtools/labels/good-first-issue). Open an issue or [start a Discussion](https://github.com/adityachilka1/mcp-devtools/discussions) before anything ambitious — Discord server coming soon.

## Acknowledgements

Built by [@adityachilka1](https://github.com/adityachilka1). Inspired by Chrome DevTools, React DevTools, and the official [MCP Inspector](https://github.com/modelcontextprotocol/inspector).

## License

[MIT](./LICENSE) © 2026 Aditya Chilka.
