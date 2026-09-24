import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { get } from "node:http";
import { createRuntime, startDashboard } from "../plugins/test-lab/extensions/test-dashboard/lib/test-lab.mjs";
import { imported, jestReport, sandbox } from "./helpers.mjs";

export const publicDirectory = fileURLToPath(new URL("../plugins/test-lab/extensions/test-dashboard/public/", import.meta.url));

test("Loopback server serves bounded read-only data, safe headers, errors and no shell endpoint", async t => {
  const { store } = await sandbox(t);
  const { run } = await imported(store);
  const server = await startDashboard(store, publicDirectory);
  t.after(() => server.close());
  const html = await fetch(server.url);
  assert.match(await html.text(), /Test dashboard/);
  assert.match(html.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(html.headers.get("access-control-allow-origin"), null);
  assert.equal(html.headers.get("referrer-policy"), "no-referrer");
  const state = await (await fetch(`${server.url}api/state`)).json();
  assert.equal(state.run.id, run.id);
  assert.equal((await fetch(`${server.url}api/state`, { headers: { Origin: "https://example.invalid" } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    get(`${server.url}api/state`, { headers: { Host: "example.invalid" } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(new URL("/api/state", server.url))).status, 404);
  assert.equal((await fetch(`${server.url}api/execute`, { method: "POST", body: "whoami" })).status, 404);
  assert.equal((await fetch(`${server.url}api/state?runId=../../outside`)).status, 400);
  assert.equal(server.status().lastRender, null);
});

test("Closing a canvas cleans up the listening server", async t => {
  const { store } = await sandbox(t);
  const server = await startDashboard(store, publicDirectory);
  assert.equal((await fetch(server.url)).status, 200);
  await server.close();
  await assert.rejects(() => fetch(server.url));
});

test("Tools and canvas actions use the same data; new panels and provider reload retain results", async t => {
  const { store, cwd, workspace } = await sandbox(t);
  const options = { cwd: () => cwd, workspacePath: () => workspace, publicDirectory, canvasError: (code, message) => Object.assign(new Error(message), { code }) };
  let runtime = createRuntime(options);
  t.after(() => runtime.close());
  const prepare = runtime.tools.find(tool => tool.name === "test_lab_prepare_run");
  const ready = JSON.parse((await prepare.handler({ format: "jest", command: "npm test" })).textResultForLlm);
  await writeFile(ready.reportPath, JSON.stringify(jestReport(["passed"])));
  const context = { instanceId: "first-view", input: ready.openCanvas.input, session: { workingDirectory: cwd } };
  const opened = await runtime.canvas.open(context);
  const importAction = runtime.canvas.actions.find(action => action.name === "import_report");
  const result = await importAction.handler({ ...context, input: { runId: ready.runId, exitCode: 0, completion: "completed" } });
  assert.equal(result.counts.passed, 1);
  const second = await runtime.canvas.open({ ...context, instanceId: "second-view" });
  assert.notEqual(opened.url, second.url);
  assert.equal((await (await fetch(`${second.url}api/state`)).json()).run.id, ready.runId);
  assert.equal((await runtime.canvas.open(context)).url, opened.url);
  await runtime.close();
  runtime = createRuntime(options);
  const rehydrated = await runtime.canvas.open({ ...context, instanceId: "after-reload" });
  assert.equal((await (await fetch(`${rehydrated.url}api/state`)).json()).run.id, ready.runId);
  assert.equal(store.openCanvas.input.scopeId, ready.openCanvas.input.scopeId);
});

test("Runtime errors use tool failure results and structured canvas exceptions", async t => {
  const { cwd } = await sandbox(t);
  const runtime = createRuntime({
    cwd: () => cwd, workspacePath: () => undefined, publicDirectory,
    canvasError: (code, message) => Object.assign(new Error(message), { code }),
  });
  t.after(() => runtime.close());
  const result = await runtime.tools[0].handler({ format: "jest", command: "npm test" });
  assert.equal(result.resultType, "failure");
  assert.match(result.textResultForLlm, /workspace_unavailable/);
  await assert.rejects(() => runtime.canvas.open({ instanceId: "test", input: {} }), { code: "workspace_unavailable" });
});
