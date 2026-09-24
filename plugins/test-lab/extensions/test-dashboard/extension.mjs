import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { createRuntime } from "./lib/test-lab.mjs";

let session;
const runtime = createRuntime({
  workspacePath: () => session?.workspacePath,
  cwd: () => process.cwd(),
  publicDirectory: fileURLToPath(new URL("./public/", import.meta.url)),
  canvasError: (code, message) => new CanvasError(code, message),
});

session = await joinSession({
  tools: runtime.tools,
  canvases: [createCanvas(runtime.canvas)],
});

async function shutdown() {
  try {
    await runtime.close();
  } catch (error) {
    process.stderr.write(`Test Lab cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
process.once("SIGTERM", async () => { await shutdown(); process.exit(process.exitCode ?? 0); });
process.once("SIGINT", async () => { await shutdown(); process.exit(process.exitCode ?? 0); });
process.once("disconnect", async () => { await shutdown(); process.exit(process.exitCode ?? 0); });
