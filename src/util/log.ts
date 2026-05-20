/**
 * Tiny stderr logger — never write progress to stdout (that's the MCP wire).
 *
 * `setQuiet(true)` suppresses `log.info()`. Warnings and errors are never
 * silenced — those carry information the user cannot live without.
 */
import kleur from "kleur";

let quiet = false;

/** Toggle the info-channel silence. Idempotent. */
export const setQuiet = (q: boolean): void => {
  quiet = q;
};

/** For tests + introspection. Not for hot paths. */
export const isQuiet = (): boolean => quiet;

export const log = {
  info: (msg: string): void => {
    if (quiet) return;
    process.stderr.write(`${kleur.dim("mcp-devtools")} ${msg}\n`);
  },
  warn: (msg: string): void => {
    process.stderr.write(`${kleur.yellow("warn")} ${msg}\n`);
  },
  err: (msg: string): void => {
    process.stderr.write(`${kleur.red("error")} ${msg}\n`);
  },
};
