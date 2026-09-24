import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rename, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReportStore } from "../plugins/test-lab/extensions/test-dashboard/lib/test-lab.mjs";
import { coverageReport, exec, imported, jestReport, sandbox } from "./helpers.mjs";

test("No SDK workspace fails explicitly without a global fallback", async () => {
  await assert.rejects(() => ReportStore.create({ cwd: process.cwd(), workspacePath: undefined }), /workspace/);
});

test("Prepared runs are visibly unfinalized after another store instance opens them", async t => {
  const { store, cwd, workspace } = await sandbox(t);
  assert.equal((await store.read()).run, null);
  const ready = await store.prepare({ format: "jest", command: "npm test" });
  const reopened = await ReportStore.create({ cwd, workspacePath: workspace });
  const result = await reopened.read();
  assert.equal(result.run.id, ready.runId);
  assert.equal(result.run.state, "awaiting-report");
  assert.equal(result.run.exitCode, null);
  assert.equal(result.run.report, null);
  assert.equal(ready.openCanvas.instanceId, reopened.openCanvas.instanceId);
});

test("Successful report, raw evidence and optional coverage survive reopening", async t => {
  const { store, cwd, workspace } = await sandbox(t);
  const prepared = await store.prepare({ format: "jest", command: "npm test", runnerVersion: "29.7.0" });
  const text = JSON.stringify(jestReport(["passed"]));
  await writeFile(prepared.reportPath, text);
  await writeFile(prepared.coveragePath, coverageReport);
  const result = await store.importReport({ runId: prepared.runId, exitCode: 0, completion: "completed", coveragePath: prepared.coveragePath });
  assert.equal(result.state, "passed");
  assert.equal(result.coverage.status, "available");
  assert.equal(result.report.counts.passed, 1);
  assert.equal(await readFile(join(prepared.directory, "raw/report.json"), "utf8"), text);
  const reopened = await ReportStore.create({ cwd, workspacePath: workspace });
  assert.deepEqual((await reopened.read({ runId: prepared.runId })).run, result);
  await assert.rejects(() => reopened.importReport({ runId: prepared.runId, exitCode: 0, completion: "completed" }), /finalized/);
});

test("Actual runner identity and executed command are recorded independently of format", async t => {
  const { store } = await sandbox(t);
  const ready = await store.prepare({ format: "junit", command: "test selection", runnerName: "Playwright Test", runnerVersion: "1.63.0" });
  await writeFile(ready.reportPath, '<testsuite><testcase name="test"/></testsuite>');
  const run = await store.importReport({ runId: ready.runId, completion: "completed", exitCode: 0, executedCommand: "npm test -- --reporter=junit" });
  assert.equal(run.runnerName, "Playwright Test");
  assert.equal(run.format, "junit");
  assert.equal(run.command, "npm test -- --reporter=junit");
});

test("Failing process is ingested rather than skipping publication", async t => {
  const { store } = await sandbox(t);
  const prepared = await store.prepare({ format: "jest", command: "npm test" });
  await writeFile(prepared.reportPath, JSON.stringify(jestReport()));
  const result = await store.importReport({ runId: prepared.runId, exitCode: 1, completion: "completed" });
  assert.equal(result.state, "failed");
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.counts.failed, 1);
  assert.ok(result.issues.some(issue => issue.code === "process_exit"));
});

for (const [name, text, completion, exitCode, expected] of [
  ["missing", null, "completed", 1, "error"],
  ["empty", "", "completed", 0, "error"],
  ["malformed", "{", "completed", 0, "error"],
  ["unsupported shape", '{"suites":[]}', "completed", 0, "error"],
  ["unknown exit", JSON.stringify(jestReport(["passed"])), "completed", null, "incomplete"],
  ["unknown completion", JSON.stringify(jestReport(["passed"])), "unknown", 0, "incomplete"],
  ["interrupted", JSON.stringify(jestReport(["passed"])), "interrupted", 130, "incomplete"],
  ["zero tests", JSON.stringify({ testResults: [], success: true }), "completed", 0, "empty"],
  ["only skipped", JSON.stringify(jestReport(["pending", "todo"])), "completed", 0, "empty"],
  ["process-only error", JSON.stringify(jestReport(["passed"])), "completed", 2, "failed"],
]) {
  test(`${name} report never looks green and remains recorded`, async t => {
    const { store } = await sandbox(t);
    const ready = await store.prepare({ format: "jest", command: "npm test" });
    if (text !== null) await writeFile(ready.reportPath, text);
    const run = await store.importReport({ runId: ready.runId, exitCode, completion });
    assert.equal(run.state, expected);
    assert.equal((await store.read()).run.state, expected);
    assert.notEqual(run.importedAt, null);
  });
}

test("Reporter interruption and contradictory counts override apparent success", async t => {
  const { store } = await sandbox(t);
  for (const change of [{ wasInterrupted: true }, { numPassedTests: 20 }]) {
    const ready = await store.prepare({ format: "jest", command: "npm test" });
    await writeFile(ready.reportPath, JSON.stringify({ ...jestReport(["passed"]), ...change }));
    const run = await store.importReport({ runId: ready.runId, exitCode: 0, completion: "completed" });
    assert.equal(run.state, "incomplete");
    assert.equal(run.report.counts.passed, 1);
  }
});

test("Coverage is optional; absence, missing files and stale repository coverage are explicit", async t => {
  const { store, cwd } = await sandbox(t);
  const absent = await imported(store);
  assert.equal(absent.run.state, "passed");
  assert.equal(absent.run.coverage.status, "unavailable");
  const ready = await store.prepare({ format: "jest", command: "npm test" });
  await writeFile(ready.reportPath, JSON.stringify(jestReport(["passed"])));
  const missing = await store.importReport({ runId: ready.runId, completion: "completed", exitCode: 0, coveragePath: ready.coveragePath });
  assert.equal(missing.state, "passed");
  assert.equal(missing.coverage.status, "unavailable");
  assert.ok(missing.issues.some(issue => issue.source === "coverage"));
  await writeFile(join(cwd, "coverage-summary.json"), coverageReport);
  const stale = await imported(store, { coveragePath: join(cwd, "coverage-summary.json") });
  assert.equal(stale.run.coverage.status, "unavailable");
  assert.ok(stale.run.issues.some(issue => issue.code === "stale_coverage"));
});

test("Malformed optional coverage does not fabricate percentages or hide valid tests", async t => {
  const { store } = await sandbox(t);
  const ready = await store.prepare({ format: "jest", command: "npm test" });
  await writeFile(ready.reportPath, JSON.stringify(jestReport(["passed"])));
  await writeFile(ready.coveragePath, "{");
  const run = await store.importReport({ runId: ready.runId, exitCode: 0, completion: "completed", coveragePath: ready.coveragePath });
  assert.equal(run.state, "passed");
  assert.equal(run.coverage.status, "unavailable");
  assert.equal(run.coverage.metrics.lines, null);
});

test("Freshness checks reject stale files and allow explicitly recorded historical runs", async t => {
  const { store, cwd } = await sandbox(t);
  const path = join(cwd, "historical.json");
  await writeFile(path, JSON.stringify(jestReport(["passed"])));
  const then = new Date("2026-01-02T00:00:01Z");
  await utimes(path, then, then);
  const current = await store.prepare({ format: "jest", command: "npm test" });
  const stale = await store.importReport({ runId: current.runId, reportPath: path, completion: "completed", exitCode: 0 });
  assert.equal(stale.state, "error");
  assert.equal(stale.issues[0].code, "stale_report");
  const historical = await store.prepare({ format: "jest", command: "npm test", evidenceStartedAt: "2026-01-02T00:00:00Z" });
  const accepted = await store.importReport({ runId: historical.runId, reportPath: path, completion: "completed", exitCode: 0 });
  assert.equal(accepted.state, "passed");
  assert.equal(accepted.evidenceStartedAt, "2026-01-02T00:00:00.000Z");
});

test("Path traversal, external symlinks and wrong extensions are rejected", async t => {
  const { store, root, cwd } = await sandbox(t);
  const external = join(root, "external.json");
  await writeFile(external, JSON.stringify(jestReport(["passed"])));
  const link = join(cwd, "link.json");
  await symlink(external, link);
  for (const reportPath of [external, link, "../external.json", "/dev/zero", "wrong.txt"]) {
    const ready = await store.prepare({ format: "jest", command: "npm test" });
    const run = await store.importReport({ runId: ready.runId, reportPath, exitCode: 0, completion: "completed" });
    assert.equal(run.state, "error");
    assert.equal(run.issues[0].code, "unsafe_path");
  }
  await assert.rejects(() => store.read({ runId: "../../escape" }), /runId/);
  await assert.rejects(() => store.prepare({ format: "jest", command: "x", workingDirectory: root }), /active worktree/);
});

test("Session evidence cannot be redirected with directory symlinks", async t => {
  const { store, root } = await sandbox(t);
  const ready = await store.prepare({ format: "jest", command: "npm test" });
  await writeFile(ready.reportPath, JSON.stringify(jestReport(["passed"])));
  const raw = join(ready.directory, "raw");
  await rename(raw, `${raw}-original`);
  await symlink(root, raw);
  const result = await store.importReport({ runId: ready.runId, exitCode: 0, completion: "completed" });
  assert.equal(result.state, "error");
  assert.equal(result.issues[0].code, "unsafe_path");
  await assert.rejects(() => readFile(join(root, "report.json")), { code: "ENOENT" });
});

test("Run evidence is isolated by repository/worktree and session", async t => {
  const { store, workspace, cwd } = await sandbox(t);
  const first = await imported(store);
  const anotherWorkspace = join(workspace, "independent-session");
  await mkdir(anotherWorkspace);
  const second = await ReportStore.create({ workspacePath: anotherWorkspace, cwd });
  assert.equal((await second.read()).run, null);
  assert.equal(second.scope.id, store.scope.id);
  const { store: anotherRepo } = await sandbox(t);
  assert.notEqual(anotherRepo.scope.id, store.scope.id);
  await assert.rejects(() => anotherRepo.read({ runId: first.run.id }), /missing/);
});

test("Two Git worktrees share repository identity but cannot share run evidence", async t => {
  const { store, root, cwd, workspace } = await sandbox(t);
  await exec("git", ["-C", cwd, "-c", "user.name=Test Lab Fixture", "-c", "user.email=test-lab@example.invalid",
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(root, "no-hooks")}`,
    "commit", "--quiet", "--allow-empty", "-m", "Original test fixture",
    "-m", "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"]);
  const otherPath = join(root, "other-worktree");
  await exec("git", ["-C", cwd, "worktree", "add", "--quiet", "--detach", otherPath]);
  const first = await imported(store);
  const second = await ReportStore.create({ cwd: otherPath, workspacePath: workspace });
  assert.equal(second.scope.repositoryId, store.scope.repositoryId);
  assert.notEqual(second.scope.worktreeId, store.scope.worktreeId);
  assert.notEqual(second.root, store.root);
  assert.equal((await second.read()).run, null);
  await assert.rejects(() => second.read({ runId: first.run.id }), /missing/);
});

test("History allows choosing a prior run, independent of panel handles", async t => {
  const { store } = await sandbox(t);
  const first = await imported(store);
  const second = await imported(store, { exitCode: 2 });
  const history = await store.read({ runId: first.run.id });
  assert.equal(history.runs.length, 2);
  assert.equal(history.run.state, "passed");
  assert.equal((await store.read({ runId: second.run.id })).run.state, "failed");
});

test("Corrupt normalized versions and altered green totals are refused", async t => {
  const { store } = await sandbox(t);
  const { prepared, run } = await imported(store);
  await writeFile(prepared.normalizedPath, JSON.stringify({ ...run, schemaVersion: 2 }));
  await assert.rejects(() => store.read(), /schema version/);
  run.report.counts.passed = 999;
  await writeFile(prepared.normalizedPath, JSON.stringify(run));
  await assert.rejects(() => store.read(), /totals disagree/);
});

test("Invalid operation inputs fail before touching evidence", async t => {
  const { store } = await sandbox(t);
  for (const value of [{}, { format: "playwright", command: "x" }, { format: "jest", command: "x", shell: "echo hi" }]) {
    await assert.rejects(() => store.prepare(value));
  }
  await assert.rejects(() => store.importReport({ runId: "not-an-id", completion: "completed", exitCode: 0 }));
  const ready = await store.prepare({ format: "jest", command: "npm test" });
  for (const value of [
    { runId: ready.runId, completion: "completed" },
    { runId: ready.runId, completion: "completed", exitCode: "0" },
    { runId: ready.runId, completion: "running", exitCode: 0 },
  ]) await assert.rejects(() => store.importReport(value));
  assert.equal((await store.read()).run.state, "awaiting-report");
});
