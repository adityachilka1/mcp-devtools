/**
 * mcp-devtools CLI entry point.
 *
 * Subcommands:
 *   proxy     spin up a transparent MCP proxy + browser UI
 *   record    record a session to a .mcptrace file
 *   open      open a previously recorded .mcptrace file in the UI
 *   doctor    probe an upstream MCP server for spec compliance
 *   diff      compare two .mcptrace files structurally
 *   version   print version
 *
 * Global flags:
 *   --quiet   suppress informational logs (warnings and errors still print)
 */
import { cac } from "cac";
import kleur from "kleur";
import { diffFrames, formatDiffReport, readTrace } from "./diff.js";
import { printResults, runDoctor } from "./doctor.js";
import { startProxy } from "./proxy.js";
import { startRecorder } from "./recorder.js";
import { setQuiet } from "./util/log.js";
import { validatePort } from "./util/validate-port.js";
import { openTrace } from "./viewer.js";

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

cli
  .command("doctor", "Probe an upstream MCP server for spec compliance")
  .option("--upstream <cmd>", "Command that launches the upstream MCP server")
  .option("--timeout <ms>", "Per-request timeout in ms", { default: 5000 })
  .option("--quiet", "Suppress informational logs")
  .action(async (opts) => {
    setQuiet(!!opts.quiet);
    if (!opts.upstream) {
      console.error("error: --upstream is required");
      process.exit(1);
    }
    const results = await runDoctor({
      upstreamCommand: opts.upstream,
      timeout: Number(opts.timeout),
    });
    printResults(results);
    process.exit(results.every((r) => r.passed) ? 0 : 1);
  });

cli
  .command("diff <baseline> <current>", "Compare two .mcptrace files structurally")
  .option("--quiet", "Suppress informational logs")
  .action(async (baselinePath: string, currentPath: string, opts) => {
    setQuiet(!!opts.quiet);
    try {
      const [baseline, current] = await Promise.all([
        readTrace(baselinePath),
        readTrace(currentPath),
      ]);
      const report = diffFrames(baseline, current);
      if (report.identical) {
        process.stdout.write(`${kleur.green("✓")} ${formatDiffReport(report)}\n`);
        process.exit(0);
      }
      process.stdout.write(`${kleur.red("✗")} ${formatDiffReport(report)}\n`);
      process.exit(1);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli.help();
cli.version(VERSION);
cli.parse();
