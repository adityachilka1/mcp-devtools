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

### Log rotation for long-running sessions

For sessions that may run for hours or days, cap the on-disk footprint with `--rotate <size>` and `--keep <N>`:

```bash
mcp-devtools record --upstream "node ./my-mcp-server.js" \
  --out session.mcptrace --rotate 10MB --keep 5
```

When the active trace grows past `--rotate <size>` (`B`, `KB`, `MB`, `GB` — case-insensitive, e.g. `1024`, `500KB`, `10MB`, `1GB`), the recorder closes the gzip stream cleanly, shifts `session.mcptrace.1 → .2 → .3 …`, renames the active file to `.1`, and reopens a fresh `session.mcptrace`. `--keep <N>` (default `3`) caps how many rotated archives survive; older ones are deleted. Each rotated file is a complete, self-contained gzip archive — `gunzip < session.mcptrace.1` works on its own.

`mcp-devtools tail` already follows rotations: when the active file shrinks, the tail reopens from byte zero, so live monitoring keeps working across rotations.

Size is checked against bytes-fed-to-gzip (pre-compression); the on-disk archive is always smaller since gzip compresses, so `--rotate 10MB` is an upper bound on the *uncompressed* payload per archive.

## Quick start — profile mode

Recorded a session and want to know where the time went? `profile` reports per-method p50/p95/p99 latency and the slowest individual calls — Chrome DevTools Performance tab, for MCP.

```bash
mcp-devtools profile session.mcptrace
mcp-devtools profile session.mcptrace --json | jq .
```

## Quick start — summary mode

`profile` answers "where did the time go?" — `summary` answers "what happened?" in one screen. Combines the headline profile numbers with an error breakdown and (optionally) a cost estimate, so you can triage a recorded session without flipping between subcommands.

```bash
mcp-devtools summary session.mcptrace
mcp-devtools summary session.mcptrace --json | jq .
mcp-devtools summary session.mcptrace --model gpt-4o-mini
mcp-devtools summary session.mcptrace --model claude-sonnet-4-6 --pricing-file ./my-prices.yaml
```

You get:

- Total frames, wall clock, paired requests, and global error count.
- Top methods by call count with `count / p95 / errorRate` (right-aligned, tabular).
- Top-3 slowest individual calls.
- USD cost block when `--model <id>` is passed — identical math to the inspector UI.

## Quick start — cost mode (CI gate)

`summary --model <id>` shows a cost estimate. `cost` is the same number, wired as a CI gate: one line, non-zero exit when you blow the budget.

```bash
# 0 if under budget, 1 if over, 2 on I/O / config error
mcp-devtools cost session.mcptrace --model gpt-4o-mini --budget 0.05
mcp-devtools cost session.mcptrace --model gpt-4o-mini --budget 0.05 --json
mcp-devtools cost session.mcptrace --model claude-sonnet-4-6 --pricing-file ./my-prices.yaml --budget 1.00
```

Drop straight into a GitHub Actions step — no `jq`, no shell math:

```yaml
- run: mcp-devtools cost session.mcptrace --model gpt-4o-mini --budget 0.05
```

If the active model id isn't in the pricing table (so every `tools/call` resolves to the `unknown-model` basis), the gate is held open even with `--budget 0`. The rule is "we can't measure → don't fail CI" — flipping a build red on a missing model id would punish the wrong person. The human-mode output flags this with an `unknown` / `unable to price` note.

## Quick start — bench mode

Want to know how fast `serve --replay` can drain a trace, and whether a code change regresses that? `bench` runs the same per-frame replay path inside a tight loop and reports throughput.

```bash
# 1 measured run (default)
mcp-devtools bench session.mcptrace

# 5 measured runs + 1 warmup run to discard JIT effects
mcp-devtools bench session.mcptrace --iterations 5 --warmup 1

# JSON envelope for CI / regression tracking
mcp-devtools bench session.mcptrace --iterations 10 --warmup 2 --json | jq '.median.framesPerSecond'
```

You get a per-run table (warmup rows are dim and asterisked) and a summary block with `median / p95 / best / worst` for both `durationMs` and `framesPerSecond`. Warmup runs stay visible so you can spot first-iteration penalties, but they don't pollute the summary stats.

## Quick start — serve mode (replay)

Develop and test MCP clients offline. `serve --replay` reads a `.mcptrace` and impersonates the upstream server over stdio: matching requests get the recorded response (with the client's id substituted in), unknown methods get a clean `-32601` so the client sees a protocol-level failure instead of a hang.

```bash
mcp-devtools serve --replay session.mcptrace             # strict (default)
mcp-devtools serve --replay session.mcptrace --no-strict # canned { result: {} } for unknown methods
```

Point your client at this command exactly like it would a real MCP server. Identical recorded sessions become deterministic fixtures for CI.

## Quick start — tail mode

Recording a long session in one terminal and want to watch frames stream in from another, without opening the inspector? `tail` is `tail -f` for `.mcptrace`: one tidy line per frame, with a latency hint when a response pairs against a request you've already seen.

```bash
# Terminal A
mcp-devtools record --upstream "node ./my-mcp-server.js" --out session.mcptrace

# Terminal B
mcp-devtools tail session.mcptrace                    # read from start, then follow
mcp-devtools tail session.mcptrace --from-end         # only show new frames from here on
mcp-devtools tail session.mcptrace --no-follow        # print existing frames and exit
```

Output looks like:

```
14:32:11.482 → initialize#1
14:32:11.491 ← #1 (9ms)
14:32:11.503 → tools/list#2
14:32:11.518 ← #2 (15ms)
```

Where `→` is the direction arrow and `#1` is the JSON-RPC id of the response that paired with the earlier request.

`→` is client→server, `←` is server→client. Truncations and rotations are handled — if the file shrinks under us, `tail` reopens from byte zero.

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
