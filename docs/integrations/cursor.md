# Using mcp-devtools with Cursor

Cursor's MCP support lives at `~/.cursor/mcp.json` (per-user) or `<project>/.cursor/mcp.json` (per-workspace). Configuration is identical to Claude Desktop — just a different file path.

## Per-workspace setup

In your project, create `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "mcp-devtools",
      "args": ["proxy", "--upstream", "node ./my-mcp-server.js"]
    }
  }
}
```

Restart Cursor's MCP runtime via *Settings → Features → MCP → Reload*. Open `http://localhost:7456/inspect` in your browser.

## Per-user setup

Same JSON, at `~/.cursor/mcp.json`. Use absolute paths in `--upstream` since Cursor may not launch from the project directory.

## Diffing two sessions

A nice pattern for Cursor specifically — record a session, change a prompt, record another, then diff:

```bash
mcp-devtools record --upstream "node server.js" --out before.mcptrace
# ... change something ...
mcp-devtools record --upstream "node server.js" --out after.mcptrace

# (v0.2 — coming soon)
mcp-devtools diff before.mcptrace after.mcptrace
```

Diff is on the v0.2 roadmap; track [issue #2](https://github.com/adityachilka1/mcp-devtools/issues/2) for progress.
