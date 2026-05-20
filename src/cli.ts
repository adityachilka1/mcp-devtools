/**
 * mcp-devtools CLI entry point.
 *
 * Subcommands:
 *   proxy     spin up a transparent MCP proxy + browser UI
 *   record    record a session to a .mcptrace file
 *   open      open a previously recorded .mcptrace file in the UI
 *   version   print version
 *
 * Global flags:
 *   --quiet   suppress informational logs (warnings and errors still print)
 */
import { cac } from "cac";
import { startProxy } from "./proxy.js";
import { startRecorder } from "./recorder.js";
import { setQuiet } from "./util/log.js";
import { validatePort } from "./util/validate-port.js";
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
  .option("--quiet", "Suppress informational logs")
  .action(async (opts) => {
    setQuiet(!!opts.quiet);
    if (!opts.upstream) {
      console.error("error: --upstream is required");
      process.exit(1);
    }
    const port = validatePort(opts.port);
    if (!port.ok) {
      console.error(port.message);
      process.exit(1);
    }
    await startProxy({
      upstreamCommand: opts.upstream,
      port: port.value,
      transport: opts.transport,
      openBrowser: opts.open !== false,
    });
  });

cli
  .command("record", "Record an MCP session to disk")
  .option("--upstream <cmd>", "Command that launches the upstream MCP server")
  .option("--out <path>", "Output file", { default: "session.mcptrace" })
  .option("--quiet", "Suppress informational logs")
  .action(async (opts) => {
    setQuiet(!!opts.quiet);
    if (!opts.upstream) {
      console.error("error: --upstream is required");
      process.exit(1);
    }
    await startRecorder({ upstreamCommand: opts.upstream, outPath: opts.out });
  });

cli
  .command("open <file>", "Open a recorded .mcptrace file in the UI")
  .option("--port <port>", "Port for the UI", { default: 7456 })
  .option("--quiet", "Suppress informational logs")
  .action(async (file: string, opts) => {
    setQuiet(!!opts.quiet);
    const port = validatePort(opts.port);
    if (!port.ok) {
      console.error(port.message);
      process.exit(1);
    }
    await openTrace({ tracePath: file, port: port.value });
  });

cli.help();
cli.version(VERSION);
cli.parse();
