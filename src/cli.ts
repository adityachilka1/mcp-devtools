/**
 * mcp-devtools CLI entry point.
 *
 * Subcommands:
 *   proxy     spin up a transparent MCP proxy + browser UI
 *   record    record a session to a .mcptrace file
 *   open      open a previously recorded .mcptrace file in the UI
 *   version   print version
 */
import { cac } from "cac";
import { startProxy } from "./proxy.js";
import { startRecorder } from "./recorder.js";
import { openTrace } from "./viewer.js";

// Version is replaced at build time. Avoid `import ... with { type: "json" }`
// so we don't depend on Node ≥20.10 JSON import attributes inside the bundle.
const VERSION = "0.1.0";

const cli = cac("mcp-devtools");

cli
  .command("proxy", "Start a transparent MCP proxy with a live inspector UI")
  .option("--upstream <cmd>", "Command that launches the upstream MCP server")
  .option("--port <port>", "Port for the UI and proxy endpoint", { default: 7456 })
  .option("--transport <type>", "stdio | http", { default: "stdio" })
  .option("--no-open", "Don't auto-open the browser")
  .action(async (opts) => {
    if (!opts.upstream) {
      console.error("error: --upstream is required");
      process.exit(1);
    }
    await startProxy({
      upstreamCommand: opts.upstream,
      port: Number(opts.port),
      transport: opts.transport,
      openBrowser: opts.open !== false,
    });
  });

cli
  .command("record", "Record an MCP session to disk")
  .option("--upstream <cmd>", "Command that launches the upstream MCP server")
  .option("--out <path>", "Output file", { default: "session.mcptrace" })
  .action(async (opts) => {
    if (!opts.upstream) {
      console.error("error: --upstream is required");
      process.exit(1);
    }
    await startRecorder({ upstreamCommand: opts.upstream, outPath: opts.out });
  });

cli
  .command("open <file>", "Open a recorded .mcptrace file in the UI")
  .option("--port <port>", "Port for the UI", { default: 7456 })
  .action(async (file: string, opts) => {
    await openTrace({ tracePath: file, port: Number(opts.port) });
  });

cli.help();
cli.version(VERSION);
cli.parse();
