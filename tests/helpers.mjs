import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { ReportStore } from "../plugins/test-lab/extensions/test-dashboard/lib/test-lab.mjs";

export const exec = promisify(execFile);
export function jestReport(statuses = ["passed", "failed", "pending", "todo"]) {
  const failed = statuses.includes("failed");
  return {
    numTotalTests: statuses.length,
    numPassedTests: statuses.filter(value => value === "passed").length,
    numFailedTests: statuses.filter(value => value === "failed").length,
    numPendingTests: statuses.filter(value => value === "pending").length,
    numTodoTests: statuses.filter(value => value === "todo").length,
    numTotalTestSuites: 1, numPassedTestSuites: failed ? 0 : 1, numFailedTestSuites: failed ? 1 : 0, numPendingTestSuites: 0,
    success: !failed, wasInterrupted: false, startTime: 0,
    testResults: [{
      name: "sample.test.js", status: failed ? "failed" : "passed", message: "", startTime: 0, endTime: 12,
      assertionResults: statuses.map((status, index) => ({
        title: "duplicate parameter name", fullName: "arithmetic duplicate parameter name", ancestorTitles: ["arithmetic"],
        status, duration: index === 0 ? 0 : null, failureMessages: status === "failed" ? ["Expected 2, received 1."] : [],
      })),
    }],
  };
}

export function vitestReport() {
  return {
    numTotalTests: 4, numPassedTests: 1, numFailedTests: 1, numPendingTests: 1, numTodoTests: 1,
    numTotalTestSuites: 3, numPassedTestSuites: 1, numFailedTestSuites: 2, numPendingTestSuites: 0,
    success: false, startTime: 0,
    testResults: [{
      name: "sample.test.ts", status: "failed", message: "", startTime: 0, endTime: 4,
      assertionResults: ["passed", "failed", "skipped", "todo"].map(status => ({
        title: "case", fullName: "nested case", ancestorTitles: ["nested"],
        status, duration: null, failureMessages: status === "failed" ? ["A synthetic assertion failed."] : null,
      })),
    }],
  };
}

export const junitReport = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="5" failures="1" errors="1" skipped="1" time="0.025">
  <testsuite name="outer" tests="5" failures="1" errors="1" skipped="1">
    <testsuite name="nested" tests="5" failures="1" errors="1" skipped="1">
      <testcase name="duplicate" classname="arithmetic" time="0"/>
      <testcase name="duplicate" classname="arithmetic"><failure message="bad &lt;value&gt;"><![CDATA[<script>not code</script>]]></failure></testcase>
      <testcase name="environment"><error type="SetupError">Fixture unavailable</error></testcase>
      <testcase name="disabled"><skipped message="Not applicable"/></testcase>
      <testcase name="missing duration"/>
    </testsuite>
  </testsuite>
</testsuites>`;

export const coverageReport = JSON.stringify({
  total: {
    lines: { total: 3, covered: 2, skipped: 0, pct: 66.66 },
    statements: { total: 0, covered: 0, skipped: 0, pct: 100 },
    functions: { total: 1, covered: 0, pct: 0 },
  },
});

export const provenance = { path: "coverage-summary.json", sha256: "a".repeat(64), bytes: 1, modifiedAt: "2026-01-01T00:00:00.000Z" };

export async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "test-lab-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  const workspace = join(root, "session");
  await mkdir(cwd);
  await mkdir(workspace);
  await exec("git", ["init", "--quiet", cwd]);
  const store = await ReportStore.create({ cwd, workspacePath: workspace });
  return { root, cwd, workspace, store };
}

export async function imported(store, overrides = {}) {
  const prepared = await store.prepare({ format: "jest", command: "npm test" });
  await writeFile(prepared.reportPath, JSON.stringify(jestReport(["passed"])));
  const run = await store.importReport({ runId: prepared.runId, exitCode: 0, completion: "completed", ...overrides });
  return { prepared, run };
}
