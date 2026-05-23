/**
 * mcp-devtools CLI entry point.
 *
 * Subcommands:
 *   proxy     spin up a transparent MCP proxy + browser UI
 *   record    record a session to a .mcptrace file
 *   open      open a previously recorded .mcptrace file in the UI
 *   doctor    probe an upstream MCP server for spec compliance
 *   diff      compare two .mcptrace files structurally
 *   profile   per-method latency profiler for a .mcptrace file
 *   version   print version
 *
 * Global flags:
 *   --quiet   suppress informational logs (warnings and errors still print)
 */
import { cac } from "cac";
import kleur from "kleur";
import { diffFrames, formatDiffReport, readTrace } from "./diff.js";
import { printResults, printResultsJson, runDoctor } from "./doctor.js";
import { formatProfile, printProfileJson, profileTrace } from "./profile.js";
import { startProxy } from "./proxy.js";
import { startRecorder } from "./recorder.js";
import { setQuiet } from "./util/log.js";
import { validatePort } from "./util/validate-port.js";
import { openTrace } from "./viewer.js";

const VERSION = "0.1.0";
const cli = cac("mcp-devtools");

cli
  .command("proxy", "Start a transparent MCP proxy with a live inspector UI")
  .option("--upstream <cmd>", "Command (stdio) or URL (http) for the upstream MCP server")
  .option("--port <port>", "Port for the UI and proxy endpoint", { default: 7456 })
  .option("--transport <type>", "stdio | http", { default: "stdio" })
  .option("--no-open", "Don't auto-open the browser")
  .option("--model <id>", "Active model id for cost attribution (e.g. claude-sonnet-4-6)")
  .option("--pricing-file <path>", "YAML file of per-token rates; overrides the built-in table")
  .option(
    "--header <kv>",
    "Extra HTTP header for the upstream (http transport). Repeatable. Format: 'Name: value'",
    { type: [String] },
  )
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
    const httpHeaders = parseHeaderFlags(opts.header);
    await startProxy({
      upstreamCommand: opts.upstream,
      port: port.value,
      transport: opts.transport,
      openBrowser: opts.open !== false,
      modelId: opts.model,
      pricingFile: opts.pricingFile,
      httpHeaders,
    });
  });

/** Parse `--header 'Name: value'` flags into a header bag. */
function parseHeaderFlags(raw: unknown): Record<string, string> | undefined {
  if (!raw) return undefined;
  const list = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  const out: Record<string, string> = {};
  for (const item of list) {
    const idx = item.indexOf(":");
    if (idx === -1) {
      console.error(`error: --header expects 'Name: value', got: ${item}`);
      process.exit(1);
    }
    const name = item.slice(0, idx).trim().toLowerCase();
    const value = item.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

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
  .option("--json", "Emit a single JSON envelope to stdout (no colors, no per-check lines)")
  .option("--quiet", "Suppress informational logs")
  .action(async (opts) => {
    // When --json is set we want the JSON envelope to be the *only* thing on
    // stdout — info chatter still goes to stderr but we silence it by default
    // so `... --json | jq .` Just Works. Users can opt back in with explicit
    // logging if they ever want it.
    setQuiet(!!opts.quiet || !!opts.json);
    if (!opts.upstream) {
      console.error("error: --upstream is required");
      process.exit(1);
    }
    const results = await runDoctor({
      upstreamCommand: opts.upstream,
      timeout: Number(opts.timeout),
    });
    if (opts.json) {
      printResultsJson(results, { version: VERSION, upstream: opts.upstream });
    } else {
      printResults(results);
    }
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

cli
  .command("profile <trace>", "Profile per-method latency in a .mcptrace file")
  .option("--json", "Emit a single JSON envelope to stdout (no colors, no table)")
  .option("--quiet", "Suppress informational logs")
  .action(async (tracePath: string, opts) => {
    // Mirror the doctor convention — --json implies --quiet so the envelope is
    // the only thing on stdout for `... | jq .` pipelines.
    setQuiet(!!opts.quiet || !!opts.json);
    try {
      const result = await profileTrace(tracePath);
      if (opts.json) {
        printProfileJson(result);
      } else {
        process.stdout.write(`${formatProfile(result)}\n`);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli.help();
cli.version(VERSION);
cli.parse();
