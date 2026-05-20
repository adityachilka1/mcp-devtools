# vhs script — generates docs/demo.gif
# Install: brew install vhs ttyd ffmpeg
# Run:     vhs docs/demo.tape
# Output:  docs/demo.gif (committed at the top of the README)

Output docs/demo.gif

Set FontSize 14
Set Width 1200
Set Height 720
Set Theme "Dracula"
Set TypingSpeed 50ms
Set PlaybackSpeed 1.0

# 1. Show the install line
Type "npm install -g mcp-devtools"
Enter
Sleep 800ms

# 2. Start the proxy against a sample MCP server
Type "mcp-devtools proxy --upstream 'node sample-server.js'"
Enter
Sleep 2s

# 3. Pretend a client is talking — inspector pops in browser
Type "# Inspector → http://localhost:7456/inspect"
Enter
Sleep 1500ms

# 4. Send a couple of tool calls (in another shell pane in the real recording)
Type "# Tool calls flow through:"
Enter
Type "#   → initialize"
Enter
Sleep 400ms
Type "#   ← capabilities"
Enter
Sleep 400ms
Type "#   → tools/list"
Enter
Sleep 400ms
Type "#   ← 12 tools"
Enter
Sleep 400ms
Type "#   → tools/call · github.search_issues"
Enter
Sleep 400ms
Type "#   ← result"
Enter
Sleep 1500ms

# 5. Wrap up
Type "# Every frame visible. Searchable. Recordable. Replayable."
Enter
Sleep 2s
