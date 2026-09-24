import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { startDashboard } from "../../plugins/test-lab/extensions/test-dashboard/lib/test-lab.mjs";
import { imported, jestReport, sandbox } from "../helpers.mjs";

const publicDirectory = fileURLToPath(new URL("../../plugins/test-lab/extensions/test-dashboard/public/", import.meta.url));
async function browser(t) {
  const instance = await chromium.launch(process.env.TEST_LAB_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_LAB_BROWSER_EXECUTABLE, headless: true }
    : { channel: "chrome", headless: true });
  t.after(() => instance.close());
  return instance;
}

test("Actual browser renders failure evidence safely, filters, durations, history and reload", async t => {
  const { store } = await sandbox(t);
  const ready = await store.prepare({ format: "jest", command: "npm test" });
  const report = jestReport();
  const hostile = '<img src="x" onerror="document.title=\'INJECTED\'"><script>alert("unsafe")</script>';
  report.testResults[0].name = hostile;
  report.testResults[0].assertionResults[1].failureMessages = [hostile, "Expected two, got one."];
  report.testResults[0].assertionResults[1].duration = 12;
  await writeFile(ready.reportPath, JSON.stringify(report));
  await store.importReport({ runId: ready.runId, exitCode: 1, completion: "completed" });
  const server = await startDashboard(store, publicDirectory);
  t.after(() => server.close());
  const instance = await browser(t);
  const page = await instance.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => { errors.push(`Unexpected dialog: ${dialog.message()}`); void dialog.dismiss(); });
  await page.goto(server.url);
  await expect(page.locator("#run-state")).toHaveText("failed");
  await expect(page.locator("details.test")).toHaveCount(4);
  await expect(page.locator("#totals")).toContainText("Suite errors");
  assert.equal(await page.title(), "Test dashboard");
  assert.equal(await page.locator("#tests img, #tests script").count(), 0);
  await page.locator("#search").fill("Expected two");
  await expect(page.locator("details.test")).toHaveCount(1);
  await page.locator("details.test summary").click();
  await expect(page.locator(".test-body pre").first()).toHaveText(hostile);
  await page.locator("#status").selectOption("passed");
  await expect(page.locator("details.test")).toHaveCount(0);
  await page.locator("#search").fill("");
  await expect(page.locator("details.test")).toHaveCount(1);
  await expect(page.locator("details.test summary")).toContainText("0 ms");
  await page.locator("#status").selectOption("all");
  await page.locator("#order").selectOption("slow");
  await expect(page.locator("details.test summary").first()).toContainText("12 ms");
  await expect(page.locator("#coverage")).toContainText("No current-run");
  await expect.poll(() => server.status().lastRender?.runId).toBe(ready.runId);
  const next = await imported(store);
  server.refresh(next.run.id);
  await expect(page.locator("#run-state")).toHaveText("passed");
  await page.locator("#history").selectOption(ready.runId);
  await expect(page.locator("#run-state")).toHaveText("failed");
  await page.reload();
  await expect(page.locator("#history option")).toHaveCount(2);
  await page.locator("#history").selectOption(ready.runId);
  await expect(page.locator("#run-state")).toHaveText("failed");
  assert.deepEqual(errors, []);
});

test("Browser shows empty, unfinalized, invalid-report and unavailable-data states", async t => {
  const { store } = await sandbox(t);
  const server = await startDashboard(store, publicDirectory);
  t.after(() => server.close());
  const instance = await browser(t);
  const page = await instance.newPage();
  await page.goto(server.url);
  await expect(page.locator("#empty")).toBeVisible();
  const pending = await store.prepare({ format: "junit", command: "test command" });
  server.refresh(pending.runId);
  await expect(page.locator("#run-state")).toHaveText("awaiting-report");
  await expect(page.locator("#state-detail")).toContainText("interrupted");
  await store.importReport({ runId: pending.runId, exitCode: 1, completion: "completed" });
  server.refresh(pending.runId);
  await expect(page.locator("#run-state")).toHaveText("error");
  await expect(page.locator("#issues")).toContainText("missing");
  await expect(page.locator("#totals")).toContainText("Unknown");
  await writeFile(pending.normalizedPath, '{"schemaVersion":99}');
  server.refresh(pending.runId);
  await expect(page.locator("#fatal")).toBeVisible();
  await expect(page.locator("#run")).toBeHidden();
});
