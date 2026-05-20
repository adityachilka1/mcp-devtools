/**
 * `mcp-devtools doctor` — protocol-compliance probe for an upstream MCP server.
 *
 * Spawns the upstream as a child process and runs a small canonical request
 * sequence against it, then reports which checks pass and which fail. Useful
 * for first-time server authors who want a quick "am I actually compliant?"
 * gate before users yell at them.
 *
 * What we check (v0.1.2 baseline):
 *   - server responds to `initialize` with `protocolVersion`, `serverInfo`,
 *     `capabilities`
 *   - server responds to `tools/list` with a `tools` array
 *   - every tool in the list has `name`, `description`, `inputSchema`
 *   - server returns a proper JSON-RPC error envelope for an unknown method
 *   - request `id`s are correctly echoed back
 *   - responses arrive within a 5-second budget
 *   - no malformed JSON-RPC frames on the wire
 *
 * Exits 0 if all checks pass, 1 if any fail. Designed for CI use too.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import kleur from "kleur";
import { type JsonRpcFrame, parseFrames } from "./jsonrpc.js";
import { log } from "./util/log.js";

export interface DoctorOptions {
  upstreamCommand: string;
  /** Per-request timeout in ms. Defaults to 5000. */
  timeout?: number;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

interface ProbeState {
  child: ChildProcessWithoutNullStreams;
  outFrames: JsonRpcFrame[];
  byId: Map<number | string, JsonRpcFrame>;
}

const TIMEOUT_DEFAULT = 5_000;

function spawnUpstream(cmd: string): ProbeState {
  const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const [exe, ...args] = parts;
  if (!exe) throw new Error("empty --upstream command");
  const child = spawn(exe, args, {
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const outFrames: JsonRpcFrame[] = [];
  const byId = new Map<number | string, JsonRpcFrame>();
  child.stdout.on("data", (chunk: Buffer) => {
    for (const f of parseFrames(chunk)) {
      outFrames.push(f);
      if ("id" in f && f.id != null) byId.set(f.id, f);
    }
  });
  child.stderr.on("data", (c: Buffer) => process.stderr.write(c));
  return { child, outFrames, byId };
}

function send(state: ProbeState, req: object) {
  state.child.stdin.write(`${JSON.stringify(req)}\n`);
}

function waitForId(
  state: ProbeState,
  id: number | string,
  ms: number,
): Promise<JsonRpcFrame | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const f = state.byId.get(id);
      if (f) return resolve(f);
      if (Date.now() - start > ms) return resolve(null);
      setTimeout(tick, 25);
    };
    tick();
  });
}

export async function runDoctor(opts: DoctorOptions): Promise<CheckResult[]> {
  const timeout = opts.timeout ?? TIMEOUT_DEFAULT;
  const state = spawnUpstream(opts.upstreamCommand);
  const results: CheckResult[] = [];

  // ── 1. initialize ─────────────────────────────────────────────────────────
  send(state, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "mcp-devtools-doctor", version: "0.1.2" },
    },
  });
  const init = await waitForId(state, 1, timeout);
  if (!init || !("result" in init)) {
    results.push({
      name: "initialize responds",
      passed: false,
      detail: init ? "missing result field" : `no response within ${timeout}ms`,
    });
    state.child.kill();
    return results;
  }
  results.push({ name: "initialize responds", passed: true });

  const initResult = (init as { result: Record<string, unknown> }).result;
  results.push({
    name: "initialize.result has protocolVersion",
    passed: typeof initResult.protocolVersion === "string",
    detail: typeof initResult.protocolVersion === "string" ? undefined : "missing or non-string",
  });
  results.push({
    name: "initialize.result has serverInfo",
    passed: !!initResult.serverInfo && typeof initResult.serverInfo === "object",
  });
  results.push({
    name: "initialize.result has capabilities",
    passed: !!initResult.capabilities && typeof initResult.capabilities === "object",
  });

  // ── 2. tools/list ─────────────────────────────────────────────────────────
  send(state, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsRes = await waitForId(state, 2, timeout);
  const toolsResult =
    toolsRes && "result" in toolsRes
      ? (toolsRes as { result: { tools?: unknown } }).result
      : undefined;
  const toolsArr = Array.isArray(toolsResult?.tools) ? (toolsResult?.tools as unknown[]) : null;
  results.push({
    name: "tools/list responds with tools array",
    passed: !!toolsArr,
    detail: toolsArr ? `${toolsArr.length} tools` : "missing or non-array tools field",
  });

  if (toolsArr) {
    let allOk = true;
    const bad: string[] = [];
    for (const t of toolsArr) {
      const tool = t as Record<string, unknown>;
      if (typeof tool.name !== "string" || !tool.name) {
        allOk = false;
        bad.push("(unnamed)");
        continue;
      }
      if (typeof tool.description !== "string") {
        allOk = false;
        bad.push(`${tool.name}: missing description`);
      }
      if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
        allOk = false;
        bad.push(`${tool.name}: missing inputSchema`);
      }
    }
    results.push({
      name: "every tool has name + description + inputSchema",
      passed: allOk,
      detail: allOk ? undefined : bad.join(", "),
    });
  }

  // ── 3. unknown method returns JSON-RPC error ─────────────────────────────
  send(state, {
    jsonrpc: "2.0",
    id: 999,
    method: "this/definitely-does-not-exist",
    params: {},
  });
  const unknown = await waitForId(state, 999, timeout);
  const isErr = unknown && "error" in unknown;
  results.push({
    name: "unknown method returns JSON-RPC error envelope",
    passed: !!isErr,
    detail: isErr
      ? undefined
      : unknown
        ? "server returned a result for an unknown method (should be error)"
        : `no response within ${timeout}ms`,
  });

  // ── 4. ids echoed back correctly ──────────────────────────────────────────
  const idsMatch = state.byId.has(1) && state.byId.has(2) && state.byId.has(999);
  results.push({
    name: "request ids echoed back correctly",
    passed: idsMatch,
    detail: idsMatch ? undefined : "missing one of the expected ids in responses",
  });

  // ── 5. no malformed frames on the wire ───────────────────────────────────
  const malformed = state.outFrames.filter((f) => "_parseError" in f);
  results.push({
    name: "no malformed JSON-RPC frames",
    passed: malformed.length === 0,
    detail: malformed.length ? `${malformed.length} malformed frames` : undefined,
  });

  state.child.stdin.end();
  state.child.kill();
  return results;
}

export function printResults(results: CheckResult[]): void {
  const passed = results.filter((r) => r.passed).length;
  for (const r of results) {
    const tag = r.passed ? kleur.green("✓") : kleur.red("✗");
    let line = `  ${tag} ${r.name}`;
    if (r.detail) line += kleur.dim(` — ${r.detail}`);
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write("\n");
  const summary = `${passed}/${results.length} checks passed`;
  process.stdout.write(passed === results.length ? kleur.green(summary) : kleur.red(summary));
  process.stdout.write("\n");
  log.info(`doctor done. ${passed}/${results.length} checks passed.`);
}
