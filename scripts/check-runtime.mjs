import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const sdkPath = process.argv[2] ?? process.env.COPILOT_SDK_PATH;
if (!sdkPath) throw new Error("Pass the installed host SDK directory as an argument or COPILOT_SDK_PATH.");
const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(join(resolve(sdkPath), "index.js")).href);
const root = fileURLToPath(new URL("../", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "test-lab-runtime-"));
const cli = process.env.COPILOT_TEST_CLI_PATH ?? execFileSync(
  process.platform === "win32" ? "where" : "which", ["copilot"], { encoding: "utf8" },
).trim().split(/\r?\n/)[0];
const env = {
  PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? home, COPILOT_HOME: home,
  COPILOT_CACHE_HOME: join(home, "cache"), COPILOT_AUTO_UPDATE: "false",
  ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
};
const command = args => execFileSync(cli, args, { cwd: root, env, encoding: "utf8", timeout: 120_000 });
const json = args => JSON.parse(command(args));
const privateConfigPath = join(home, "mcp-config.json");
const privateConfig = `${JSON.stringify({ mcpServers: {
  "private-fixture": { type: "http", url: "https://example.invalid/mcp", tools: [] },
} })}\n`;
await writeFile(privateConfigPath, privateConfig);
let client;
let session;
try {
  console.info(command(["--version"]).split("\n")[0]);
  command(["plugin", "marketplace", "add", root]);
  const catalog = json(["plugin", "marketplace", "browse", "testing-marketplace", "--json"]);
  const entries = Array.isArray(catalog) ? catalog : catalog.plugins;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "test-lab");
  command(["plugin", "install", "test-lab@testing-marketplace"]);
  const installed = json(["plugin", "list", "--json"]);
  assert.equal(installed.filter(plugin => plugin.name === "test-lab" && plugin.enabled).length, 1);
  const mcps = json(["mcp", "list", "--json"]).mcpServers;
  assert.equal(mcps["test-lab-context7"].url, "https://mcp.context7.com/mcp");
  assert.deepEqual(mcps["test-lab-context7"].tools, ["resolve-library-id", "query-docs"]);
  assert.ok(!mcps["test-lab-playwright"], "Azure must remain a private prerequisite.");
  const skills = json(["skill", "list", "--json"]);
  assert.ok(skills.some(skill => skill.name === "test-lab" && skill.enabled));
  console.info("Marketplace, plugin, shared Context7 and skill discovered in disposable configuration.");

  client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: cli, env, args: ["--experimental"] }),
    baseDirectory: home, workingDirectory: root, useLoggedInUser: true, logLevel: "error",
  });
  await client.start();
  console.info(`SDK runtime: ${JSON.stringify(await client.getStatus())}`);
  const sessionConfig = {
    workingDirectory: root, enableConfigDiscovery: true,
    requestExtensions: true, requestCanvasRenderer: true,
    enableExperimentalMode: true,
    extensionSdkPath: resolve(sdkPath),
    enableSessionTelemetry: false,
    // Offline component validation only; these per-test settings never affect the user's client.
    disabledMcpServers: ["github-mcp-server", "test-lab-context7", "private-fixture"],
    onPermissionRequest: async () => ({ kind: "approve-once" }),
  };
  session = await client.createSession(sessionConfig);
  await session.rpc.permissions.folderTrust.addTrusted({ path: root });
  await session.rpc.plugins.reload({ reloadMcp: false });
  await session.rpc.tools.initializeAndValidate();
  await session.rpc.agent.reload();
  const agents = (await session.rpc.agent.list()).agents;
  const engineer = agents.find(agent => agent.name === "Test Engineer" || agent.id.includes("test-lab-engineer"));
  assert.ok(engineer, `Plugin Test Engineer agent must be discoverable: ${JSON.stringify(agents)}; extensions: ${JSON.stringify(await session.rpc.extensions.list())}`);
  assert.ok(!engineer.model, "Test Engineer inherits the user model.");
  let canvases = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    canvases = (await session.rpc.canvas.list()).canvases;
    if (canvases.some(canvas => canvas.canvasId === "test-dashboard")) break;
    await delay(250);
  }
  const canvas = canvases.find(canvas => canvas.canvasId === "test-dashboard");
  assert.ok(canvas, `Canvas unavailable: ${JSON.stringify(await session.rpc.extensions.list())}`);
  assert.match(canvas.extensionId, /plugin/);
  console.info(`Plugin canvas provider: ${canvas.extensionId}`);
  assert.ok(canvas.actions.some(action => action.name === "import_report"));
  await session.rpc.tools.initializeAndValidate();
  await session.rpc.agent.select({ name: engineer.id });
  await session.rpc.tools.initializeAndValidate();
  const offered = (await session.rpc.tools.getCurrentMetadata()).tools.map(tool => tool.name);
  for (const name of ["test_lab_prepare_run", "test_lab_import_report", "test_lab_read_run", "open_canvas", "invoke_canvas_action"]) {
    assert.ok(offered.includes(name), `Selected Test Engineer is missing ${name}.`);
  }
  assert.ok(!offered.some(name => /browser_evaluate|browser_run_code|take_screenshot|file_upload/.test(name)));
  const preparedResult = await session.rpc.tools.execute({
    name: "test_lab_prepare_run", arguments: { format: "junit", command: "synthetic runtime contract fixture (not repository test results)" },
  });
  assert.equal(preparedResult.resultType, "success", preparedResult.textResultForLlm);
  const prepared = JSON.parse(preparedResult.textResultForLlm);
  assert.ok(prepared.runId);
  await writeFile(prepared.reportPath, '<testsuite tests="1" failures="1"><testcase name="runtime fixture"><failure message="intentional fixture"/></testcase></testsuite>');
  const imported = await session.rpc.tools.execute({
    name: "test_lab_import_report", arguments: { runId: prepared.runId, exitCode: 1, completion: "completed" },
  });
  assert.equal(imported.resultType, "success", imported.textResultForLlm);
  assert.equal(JSON.parse(imported.textResultForLlm).state, "failed");
  const panel = await session.rpc.canvas.open(prepared.openCanvas);
  assert.equal((await (await fetch(`${panel.url}api/state`)).json()).run.id, prepared.runId);
  await assert.rejects(() => session.rpc.canvas.open({ canvasId: "test-dashboard", instanceId: "invalid-input", input: { scopeId: 1 } }), /canvas_input_invalid|schema|input/i);
  await assert.rejects(() => session.rpc.canvas.action.invoke({ instanceId: panel.instanceId, actionName: "canvas.open", input: {} }), /canvas_reserved_action_name|reserved/i);
  await session.rpc.canvas.close({ instanceId: panel.instanceId });
  const second = await session.rpc.canvas.open({ ...prepared.openCanvas, instanceId: "new-panel" });
  assert.equal((await (await fetch(`${second.url}api/state`)).json()).run.report.counts.failed, 1);
  await session.rpc.extensions.reload();
  let providerReady = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const registered = (await session.rpc.canvas.list()).canvases;
    if (registered.some(item => item.canvasId === "test-dashboard")) { providerReady = true; break; }
    await delay(250);
  }
  assert.ok(providerReady, `Provider must reconnect after reload: ${JSON.stringify(await session.rpc.extensions.list())}`);
  const openAfterReload = (await session.rpc.canvas.listOpen()).openCanvases;
  if (!openAfterReload.length) console.info("Runtime cleared open-panel bookkeeping on extension reload; reopening the same native handle.");
  const restored = await session.rpc.canvas.open({ ...prepared.openCanvas, instanceId: "new-panel" });
  assert.equal((await (await fetch(`${restored.url}api/state`)).json()).run.id, prepared.runId);
  await session.rpc.canvas.close({ instanceId: "new-panel" });
  console.info(`Agent ${engineer.id}, tools, actions, validation, fresh panels and provider reload verified (RPC/HTTP, not visual proof).`);
  const saved = await readFile(prepared.normalizedPath, "utf8");
  assert.equal(JSON.parse(saved).schemaVersion, 1);
  const sessionId = session.sessionId;
  await session.disconnect();
  session = await client.resumeSession(sessionId, sessionConfig);
  await session.rpc.plugins.reload({ reloadMcp: false });
  await session.rpc.tools.initializeAndValidate();
  const readBack = await session.rpc.tools.execute({ name: "test_lab_read_run", arguments: { runId: prepared.runId } });
  assert.equal(JSON.parse(readBack.textResultForLlm).run.counts.failed, 1);
  command(["plugin", "disable", "test-lab@testing-marketplace"]);
  assert.equal(json(["plugin", "list", "--json"]).find(plugin => plugin.name === "test-lab").enabled, false);
  await session.rpc.plugins.reload({ reloadMcp: false });
  assert.ok(!(await session.rpc.extensions.list()).extensions.some(item => item.id === canvas.extensionId && item.status === "running"));
  command(["plugin", "enable", "test-lab@testing-marketplace"]);
  assert.equal(json(["plugin", "list", "--json"]).find(plugin => plugin.name === "test-lab").enabled, true);
  await session.rpc.plugins.reload({ reloadMcp: false });
  assert.equal(await readFile(privateConfigPath, "utf8"), privateConfig);
  console.info("Disable/re-enable verified without changing any user-owned MCP connection.");
} finally {
  if (session) await session.disconnect();
  if (client) {
    const errors = await client.stop();
    if (errors.length) throw new AggregateError(errors, "Runtime cleanup failed.");
  }
  await rm(home, { recursive: true, force: true });
}
