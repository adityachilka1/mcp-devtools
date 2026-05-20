# Using mcp-devtools with Cline (VS Code)

Cline is a VS Code extension that supports MCP servers. The wrapper trick from the Claude Desktop guide applies here too.

## Setup

Open the Cline MCP settings in VS Code (*Cmd-Shift-P → "Cline: MCP Settings"*). Add or wrap a server:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "mcp-devtools",
      "args": ["proxy", "--upstream", "node /abs/path/to/server.js"]
    }
  }
}
```

Use absolute paths — VS Code's process environment doesn't include your shell's `PATH` extensions.

Reload the MCP runtime via Cline's *Reload* button. Then open `http://localhost:7456/inspect`.

## Tip — VS Code extension (planned)

A first-class VS Code extension is on the v0.3 roadmap — it'll show the inspector inside VS Code's webview panel instead of an external browser. Star [issue #5](https://github.com/adityachilka1/mcp-devtools/issues/5) to follow.
