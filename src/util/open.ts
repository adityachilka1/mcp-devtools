/** Cross-platform "open a URL in the user's default browser". */
import { spawn } from "node:child_process";

export async function openBrowserAt(url: string): Promise<void> {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32"  ? "start" :
                                    "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}
