import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function withNoTailscaleOnPath<T>(run: () => T | Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-no-tailscale-"));
  process.env.PATH = emptyBinDir;
  try {
    return await run();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    fs.rmSync(emptyBinDir, { recursive: true, force: true });
  }
}
