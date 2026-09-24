import ts from "typescript";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const sdk = process.argv[2] ?? process.env.COPILOT_SDK_PATH;
if (!sdk) throw new Error("Pass the installed host SDK directory as an argument or COPILOT_SDK_PATH; do not install/vendor the SDK.");
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "test-lab-sdk-types-"));
try {
  const check = join(temp, "check.mts");
  await writeFile(check, `
import { createCanvas, type JoinSessionConfig } from ${JSON.stringify(join(resolve(sdk), "extension.js"))};
import { createRuntime } from ${JSON.stringify(join(root, "src/runtime.ts"))};
const runtime = createRuntime({
  workspacePath: () => undefined, cwd: () => ".", publicDirectory: ".",
  canvasError: (code: string, message: string) => new Error(code + message),
});
const config: JoinSessionConfig = { tools: runtime.tools, canvases: [createCanvas(runtime.canvas)] };
void config;
`);
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram([...parsed.fileNames, check], {
    ...parsed.options, allowImportingTsExtensions: true,
    typeRoots: [join(root, "node_modules/@types")],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => "\n",
    }));
    process.exitCode = 1;
  } else console.info("Canvas, action and tool wiring matches the installed host SDK types.");
} finally {
  await rm(temp, { recursive: true, force: true });
}
