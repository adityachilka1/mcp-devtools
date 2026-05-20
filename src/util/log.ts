/** Tiny stderr logger — never write progress to stdout (that's the MCP wire). */
import kleur from "kleur";

export const log = {
  info: (msg: string) => process.stderr.write(`${kleur.dim("mcp-devtools")} ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`${kleur.yellow("warn")} ${msg}\n`),
  err:  (msg: string) => process.stderr.write(`${kleur.red("error")} ${msg}\n`),
};
