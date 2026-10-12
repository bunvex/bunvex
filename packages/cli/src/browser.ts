// Opening a URL in the default browser, as the `open` package Convex's CLI uses does by default: the platform's
// opener (`open` on macOS, `cmd /c start` on Windows, `xdg-open` elsewhere), not waited for; it fails only when the
// opener cannot be started (e.g. a headless machine without `xdg-open`).
import { spawn } from "node:child_process";

export function openInBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url.replaceAll("&", "^&")]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
