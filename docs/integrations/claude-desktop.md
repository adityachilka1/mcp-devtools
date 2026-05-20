# Using mcp-devtools with Claude Desktop

This guide walks you through pointing Claude Desktop at `mcp-devtools` so you can inspect every MCP call your conversations make.

## The trick

Claude Desktop talks to MCP servers you configure in `claude_desktop_config.json`. Instead of pointing it directly at your server, you point it at `mcp-devtools proxy`, which then forwards to your real server. The protocol is identical — Claude Desktop doesn't notice.

## One-time setup

1. **Install `mcp-devtools` globally.**
   ```bash
   npm install -g mcp-devtools
   ```

2. **Find your config file.**
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Linux: `~/.config/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

3. **Wrap your existing server entry.**

   Before:
   ```jsonc
   {
     "mcpServers": {
       "my-server": {
         "command": "node",
         "args": ["/path/to/my-mcp-server.js"]
       }
     }
   }
   ```

   After:
   ```jsonc
   {
     "mcpServers": {
       "my-server": {
         "command": "mcp-devtools",
         "args": ["proxy", "--upstream", "node /path/to/my-mcp-server.js"]
       }
     }
   }
   ```

4. **Restart Claude Desktop** so it re-spawns the server.

5. **Open the inspector.**
   ```
   http://localhost:7456/inspect
   ```

Every tool call Claude makes through that server now streams into the inspector in real time. The conversation works exactly as it did before.

## Multiple servers

You can proxy as many servers as you have. Just use a different port per server:

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "mcp-devtools",
      "args": ["proxy", "--upstream", "github-mcp-server", "--port", "7457"]
    },
    "slack": {
      "command": "mcp-devtools",
      "args": ["proxy", "--upstream", "slack-mcp-server", "--port", "7458"]
    }
  }
}
```

Each inspector tab is independent.

## Common gotchas

- **`mcp-devtools` not found.** If you installed globally and Claude Desktop still says "command not found", it's because Claude Desktop on macOS launches with a sanitised `PATH` that doesn't include `/usr/local/bin`. Use the absolute path: `/usr/local/bin/mcp-devtools` or `$(which mcp-devtools)`.
- **Port already in use.** The default 7456 is rarely taken, but if it is, pass `--port 7457` (and remember to use the matching URL in your browser).
- **No frames in the inspector.** Make sure Claude Desktop is actually invoking the server — start a fresh conversation that requires a tool from that server.

## Going further

- **Record a session for a bug report.** Use [`mcp-devtools record`](../../README.md#quick-start--record-mode) instead of `proxy` and attach the `.mcptrace` file to your issue.
- **Embed mode** — if you author the MCP server, see [embed mode](../../README.md#quick-start--embed-mode) to bake the inspector into the server itself.
