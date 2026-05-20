export type PortCheck = { ok: true; value: number } | { ok: false; message: string };

function basePortError(got: unknown): string {
  return `error: --port must be between 1024 and 65535 (got ${String(got)})`;
}

export function validatePort(raw: unknown): PortCheck {
  const port = Number(raw);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { ok: false, message: basePortError(raw) };
  }

  if (port < 1024) {
    return {
      ok: false,
      message: `${basePortError(raw)}; ports below 1024 usually require root, pick a higher port`,
    };
  }

  return { ok: true, value: port };
}
