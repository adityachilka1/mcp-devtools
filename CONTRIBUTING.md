# Contributing to mcp-devtools

Thanks for being here. This project moves fast and we're happy to ship your patches the same day if they're well-scoped.

## Quick start

```bash
git clone https://github.com/adityachilka1/mcp-devtools
cd mcp-devtools
pnpm install
pnpm test
```

## How to pick something to work on

- New here? Open issues labeled [`good-first-issue`](https://github.com/adityachilka1/mcp-devtools/labels/good-first-issue). They take less than an hour and we'll help you ship.
- Want something bigger? Check [`help-wanted`](https://github.com/adityachilka1/mcp-devtools/labels/help-wanted).
- Have your own idea? Open a draft issue or a draft PR. We'd rather catch a misalignment early than have you build the wrong thing.

## Pull request checklist

- [ ] Tests cover the change. `pnpm test` is green.
- [ ] `pnpm lint && pnpm typecheck` are clean.
- [ ] User-facing changes have a one-line entry in `CHANGELOG.md` under `## Unreleased`.
- [ ] If the change affects the UI, attach a screenshot or short GIF.

## Design tenets

These are non-negotiable. New features that violate any of them won't be merged.

1. **Local-first.** No data leaves the user's machine. Ever.
2. **Drop-in.** A user with a working MCP server should get value within 60 seconds, with zero code changes.
3. **No daemons.** The tool starts when you invoke it and dies when you Ctrl-C.
4. **Protocol-agnostic.** We don't bake in assumptions about which MCP features a server uses.
5. **Small.** The shipped binary should never need more than 30 MB.

## Code style

We use [Biome](https://biomejs.dev/) for both lint and format. Run `pnpm format` before pushing.

## Reporting security issues

Please email security@your-domain.example instead of opening a public issue. We respond within 72 hours.
