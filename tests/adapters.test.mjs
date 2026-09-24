import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeReport, parseCoverage } from "../plugins/test-lab/extensions/test-dashboard/lib/test-lab.mjs";
import { coverageReport, jestReport, junitReport, provenance, vitestReport } from "./helpers.mjs";

test("Jest preserves pass/fail/skip/todo, duplicate names, zero durations and raw provenance", () => {
  const result = normalizeReport("jest", JSON.stringify(jestReport()));
  assert.deepEqual(result.counts, { total: 4, passed: 1, failed: 1, skipped: 1, todo: 1, error: 0, unknown: 0 });
  assert.equal(result.issues.length, 0);
  const tests = result.suites[0].tests;
  assert.equal(new Set(tests.map(test => test.id)).size, 4);
  assert.equal(tests[0].durationMs, 0);
  assert.equal(tests[1].durationMs, null);
  assert.equal(tests[2].rawStatus, "pending");
  assert.equal(tests[2].source.pointer, "/testResults/0/assertionResults/2");
  assert.equal(result.durationMs, null);
  assert.equal(result.startedAt, "1970-01-01T00:00:00.000Z");
});

test("Vitest independently maps logical suites and skipped/todo outcomes", () => {
  const result = normalizeReport("vitest", JSON.stringify(vitestReport()));
  assert.deepEqual(result.counts, { total: 4, passed: 1, failed: 1, skipped: 1, todo: 1, error: 0, unknown: 0 });
  assert.equal(result.issues.length, 0);
  assert.equal(result.suites.length, 1);
  assert.equal(result.reportedTotals["report.numTotalTestSuites"], 3);
});

test("Vitest pending is incomplete, not skipped or passing", () => {
  const report = vitestReport();
  report.testResults[0].assertionResults[2].status = "pending";
  const result = normalizeReport("vitest", JSON.stringify(report));
  assert.equal(result.counts.unknown, 1);
  assert.equal(result.counts.skipped, 0);
  assert.ok(result.issues.some(issue => issue.code === "unknown_status"));
  assert.ok(!result.issues.some(issue => issue.code === "contradictory_total"));
});

for (const format of ["jest", "vitest"]) {
  test(`${format} preserves suite collection/setup errors without test rows`, () => {
    const report = { testResults: [{ name: "setup.test.js", status: "failed", message: "Synthetic collection error", assertionResults: [] }], success: false };
    const result = normalizeReport(format, JSON.stringify(report));
    assert.equal(result.counts.total, 0);
    assert.equal(result.suiteErrors, 1);
    assert.match(result.suites[0].errors[0], /collection error/);
  });
  test(`${format} rejects malformed JSON, invalid assertion structure and negative duration`, () => {
    for (const value of ["{", "console output", JSON.stringify({ testResults: [{}] }), JSON.stringify({ testResults: [{ name: "a", assertionResults: [{ title: "x", duration: -1 }] }] })]) {
      assert.throws(() => normalizeReport(format, value));
    }
  });
  test(`${format} records unsupported status and does not inherit object properties`, () => {
    const report = { testResults: [{ name: "test", status: "passed", assertionResults: [{ title: "case", status: "__proto__" }] }] };
    const result = normalizeReport(format, JSON.stringify(report));
    assert.equal(result.counts.unknown, 1);
    assert.ok(result.issues.length);
  });
  test(`${format} derives totals and flags contradictory reported numbers and success`, () => {
    const report = format === "jest" ? jestReport() : vitestReport();
    report.numPassedTests = 88;
    report.success = true;
    const result = normalizeReport(format, JSON.stringify(report));
    assert.equal(result.counts.passed, 1);
    assert.ok(result.issues.some(issue => issue.code === "contradictory_total"));
    assert.ok(result.issues.some(issue => issue.code === "contradictory_status"));
  });
}

test("Jest suite message containing duplicated failure output does not inflate error counts", () => {
  const report = jestReport();
  report.testResults[0].message = "Formatted assertion failure output";
  assert.equal(normalizeReport("jest", JSON.stringify(report)).suiteErrors, 0);
});

test("Vitest afterAll error is retained alongside failed assertions", () => {
  const report = vitestReport();
  report.testResults[0].message = "afterAll hook failed";
  assert.equal(normalizeReport("vitest", JSON.stringify(report)).suiteErrors, 1);
});

test("JUnit preserves nested suites, duplicate tests, setup errors, raw text and missing values", () => {
  const result = normalizeReport("junit", junitReport);
  assert.deepEqual(result.counts, { total: 5, passed: 2, failed: 1, error: 1, skipped: 1, todo: 0, unknown: 0 });
  assert.equal(result.suites.length, 2);
  assert.equal(result.suites[1].parentId, result.suites[0].id);
  assert.equal(result.issues.length, 0);
  assert.equal(result.durationMs, 25);
  assert.equal(result.suites[1].tests[0].durationMs, 0);
  assert.equal(result.suites[1].tests[1].durationMs, null);
  assert.match(result.suites[1].tests[1].messages[0], /bad <value>.*<script>/s);
  assert.equal(new Set(result.suites[1].tests.map(test => test.id)).size, 5);
});

test("JUnit suite-only failure remains evidence even with no assertions", () => {
  const result = normalizeReport("junit", '<testsuite name="setup" tests="0"><error message="Collection failed"/></testsuite>');
  assert.equal(result.suiteErrors, 1);
  assert.equal(result.counts.total, 0);
  assert.match(result.suites[0].errors[0], /Collection failed/);
});

test("Node-style JUnit root testcases are a source-backed group, including mixed nested suites", () => {
  const report = '<testsuites tests="3" failures="1" skipped="1"><testcase name="flat pass"/><testcase name="flat failure"><failure>original failure text</failure></testcase><testsuite name="nested"><testcase name="skip"><skipped/></testcase></testsuite></testsuites>';
  const result = normalizeReport("junit", report);
  assert.deepEqual(result.counts, { total: 3, passed: 1, failed: 1, skipped: 1, todo: 0, error: 0, unknown: 0 });
  assert.equal(result.issues.length, 0);
  assert.equal(result.suites[0].name, "(ungrouped tests)");
  assert.equal(result.suites[0].source, "/testsuites");
  assert.equal(result.suites[0].tests[0].source.pointer, "/testsuites/testcase[0]");
  assert.equal(result.suites[0].tests[1].messages[0], "original failure text");
});

test("Nested XML failure text is collected once and remains in source order", () => {
  const result = normalizeReport("junit", '<testsuite><testcase name="mixed"><failure message="header">before<a>inside<b>deep</b></a>after</failure></testcase></testsuite>');
  assert.equal(result.suites[0].tests[0].messages[0], "header\nbeforeinsidedeepafter");
});

test("JUnit totals are validated, and incompatible testcase outcomes are not green", () => {
  const result = normalizeReport("junit", '<testsuite tests="20"><testcase name="one"><skipped/><failure/></testcase></testsuite>');
  assert.equal(result.counts.total, 1);
  assert.ok(result.issues.some(issue => issue.code === "contradictory_total"));
  assert.ok(result.issues.some(issue => issue.code === "contradictory_status"));
});

for (const [name, xml] of [
  ["external entity", '<!DOCTYPE testsuite [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuite><testcase name="&x;"/></testsuite>'],
  ["entity expansion", '<!DOCTYPE testsuite [<!ENTITY a "many">]><testsuite>&a;</testsuite>'],
  ["processing instruction", '<?xml-stylesheet href="https://example.invalid/file"?><testsuite/>'],
  ["excessive nesting", "<testsuites>".repeat(70) + "</testsuites>".repeat(70)],
  ["malformed XML", '<testsuite><testcase name="broken"></testsuite>'],
  ["non-JUnit XML", "<html/>"],
  ["multiple roots", "<testsuite/><testsuite/>"],
  ["invalid numeric attribute", '<testsuite tests="NaN"/>'],
  ["partial time attribute", '<testsuite time="1second"/>'],
  ["undeclared entity", '<testsuite><testcase name="&unknown;"/></testsuite>'],
  ["incorrectly cased entity", '<testsuite><testcase name="&LT;"/></testsuite>'],
  ["invalid character reference", '<testsuite><testcase name="&#0;"/></testsuite>'],
]) test(`JUnit rejects ${name}`, () => assert.throws(() => normalizeReport("junit", xml)));

test("DTD-looking text in CDATA is inert evidence, not an XML declaration", () => {
  const result = normalizeReport("junit", '<testsuite><testcase name="text"><failure><![CDATA[<!DOCTYPE html> &unknown;]]></failure></testcase></testsuite>');
  assert.equal(result.counts.failed, 1);
  assert.equal(result.suites[0].tests[0].messages[0], "<!DOCTYPE html> &unknown;");
});

test("JUnit no counts, zero tests, and unsupported outcome markup stay distinct", () => {
  const empty = normalizeReport("junit", "<testsuite/>");
  assert.equal(empty.counts.total, 0);
  assert.deepEqual(empty.reportedTotals, {});
  const zero = normalizeReport("junit", '<testsuite tests="0"/>');
  assert.equal(zero.reportedTotals["/testsuite.tests"], 0);
  const unsupported = normalizeReport("junit", '<testsuite><testcase name="x"><rerunFailure/></testcase></testsuite>');
  assert.ok(unsupported.issues.some(issue => issue.code === "unsupported_junit_element"));
});

test("Actual Playwright Test JUnit producer output uses the existing generic adapter", async () => {
  const fixture = await readFile(new URL("./fixtures/playwright-junit.xml", import.meta.url), "utf8");
  const result = normalizeReport("junit", fixture);
  assert.deepEqual(result.counts, { total: 5, passed: 2, failed: 1, skipped: 2, todo: 0, error: 0, unknown: 0 });
  assert.equal(result.issues.length, 0);
  assert.ok(result.suites.flatMap(suite => suite.tests).some(test => test.messages.some(message => message.includes("Expected: 2"))));
});

test("Empty, oversized and unsupported report inputs fail explicitly", () => {
  for (const format of ["jest", "vitest", "junit"]) assert.throws(() => normalizeReport(format, " \n"), /empty/);
  assert.throws(() => normalizeReport("playwright", "{}"), /not supported/);
  assert.throws(() => normalizeReport("jest", " ".repeat(16 * 1024 * 1024 + 1)), /16 MiB/);
});

test("The exact 50,000-test resource bound is accepted and one extra test is rejected", () => {
  const assertions = Array.from({ length: 50_000 }, () => ({ title: "parameter", status: "passed" }));
  const report = { testResults: [{ name: "bounded", status: "passed", assertionResults: assertions }] };
  assert.equal(normalizeReport("jest", JSON.stringify(report)).counts.total, 50_000);
  assertions.push({ title: "one too many", status: "passed" });
  assert.throws(() => normalizeReport("jest", JSON.stringify(report)), /50000/);
});

test("Normalized expansion is bounded even when a short input shares a huge suite name", () => {
  const report = { testResults: [{
    name: "x".repeat(512 * 1024), status: "passed",
    assertionResults: Array.from({ length: 100 }, () => ({ title: "small", status: "passed" })),
  }] };
  assert.throws(() => normalizeReport("jest", JSON.stringify(report)), /expansion budget/);
});

test("Coverage preserves absent metrics, zero counts and empty denominator without invented percentages", () => {
  const result = parseCoverage(coverageReport, provenance);
  assert.equal(result.status, "available");
  assert.equal(result.metrics.branches, null);
  assert.equal(result.metrics.functions.percent, 0);
  assert.equal(result.metrics.functions.skipped, null);
  assert.equal(result.metrics.statements.percent, null);
  assert.equal(result.metrics.statements.reportedPercent, 100);
  assert.equal(result.metrics.lines.covered, 2);
  assert.deepEqual(result.source, provenance);
});

test("Coverage rejects malformed and contradictory totals", () => {
  for (const value of ["{", "{}", '{"total":{}}', '{"total":{"lines":{"total":1,"covered":2,"pct":100}}}', '{"total":{"lines":{"total":2,"covered":1,"pct":100}}}']) {
    assert.throws(() => parseCoverage(value, provenance));
  }
});
