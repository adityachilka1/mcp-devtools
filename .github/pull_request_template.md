<!-- Thanks for sending a PR. A few quick prompts to help us review fast. -->

## What this changes

<!-- One or two sentences. Not a regurgitation of the diff — the *why*. -->

## How I verified it

<!-- Tick what applies. -->
- [ ] `pnpm test` passes locally
- [ ] `pnpm lint && pnpm typecheck` clean
- [ ] Manual smoke test (proxy/record/open) against a real or fake upstream
- [ ] Screenshot/GIF attached for UI changes
- [ ] Recorded `.mcptrace` attached if behaviour around frame handling changed

## Design tenets compliance

`mcp-devtools` has five non-negotiable tenets ([CONTRIBUTING.md](../CONTRIBUTING.md#design-tenets)). Confirm your change respects them:

- [ ] **Local-first** — no data leaves the user's machine
- [ ] **Drop-in** — users get value in 60 seconds with zero server changes
- [ ] **No daemons** — process starts when invoked, dies on Ctrl-C
- [ ] **Protocol-agnostic** — no assumptions about which MCP features a server uses
- [ ] **Small** — shipped binary still under 30 MB

## Linked issue

<!-- e.g. Closes #42 -->
