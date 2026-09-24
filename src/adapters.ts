import {
  FORMATS, MAX_REPORT_BYTES, MAX_TESTS, ReportError, array, checkTotal, countTests,
  issue, numeric, object, optionalString, string,
} from "./model.js";
import type { Format, Issue, ParsedReport, Status, Suite, TestCase } from "./model.js";
import { parseJUnit } from "./junit.js";

function messages(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  return array(value, label).map((item, index) => string(item, `${label}[${index}]`));
}

function elapsed(start: unknown, end: unknown, label: string): number | null {
  const from = numeric(start, `${label}.startTime`);
  const to = numeric(end, `${label}.endTime`);
  if (from === null || to === null) return null;
  if (to < from) throw new ReportError("invalid_report", `${label}.endTime precedes startTime.`);
  return to - from;
}

function timestamp(value: unknown): string | null {
  const time = numeric(value, "startTime");
  if (time === null) return null;
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) throw new ReportError("invalid_report", "startTime is outside the supported date range.");
  return date.toISOString();
}

function parseJsonReport(format: "jest" | "vitest", input: unknown): ParsedReport {
  const data = object(input, "report");
  const issues: Issue[] = [];
  const totals: Record<string, number> = {};
  let testCount = 0;
  // Vitest's pending state means queued/running; Jest uses it for skipped tests.
  const statusMap: Record<string, Status> = format === "jest"
    ? { passed: "passed", failed: "failed", pending: "skipped", skipped: "skipped", todo: "todo", disabled: "skipped" }
    : { passed: "passed", failed: "failed", skipped: "skipped", todo: "todo", disabled: "skipped" };
  const suites: Suite[] = array(data.testResults, "testResults").map((value, si) => {
    const pointer = `/testResults/${si}`;
    const row = object(value, pointer);
    const name = string(row.name, `${pointer}/name`);
    const rawStatus = optionalString(row.status);
    const assertions = array(row.assertionResults, `${pointer}/assertionResults`);
    testCount += assertions.length;
    if (testCount > MAX_TESTS) throw new ReportError("report_too_large", `Reports are limited to ${MAX_TESTS} tests.`);
    const tests: TestCase[] = assertions.map((assertion, ti) => {
      const at = `${pointer}/assertionResults/${ti}`;
      const item = object(assertion, at);
      const raw = optionalString(item.status);
      const status = (raw !== null && Object.hasOwn(statusMap, raw) ? statusMap[raw] : undefined) ?? "unknown";
      if (status === "unknown") issues.push(issue("unknown_status", "An assertion has an unsupported or unfinished status.", at));
      const title = string(item.title, `${at}/title`);
      const ancestors = messages(item.ancestorTitles, `${at}/ancestorTitles`);
      const location = item.location === undefined || item.location === null ? null : object(item.location, `${at}/location`);
      return {
        id: `${si}:${ti}`, name: title,
        fullName: optionalString(item.fullName) ?? [...ancestors, title].join(" "),
        ancestors, status, rawStatus: raw,
        durationMs: numeric(item.duration, `${at}/duration`),
        messages: messages(item.failureMessages, `${at}/failureMessages`),
        source: {
          pointer: at, file: name,
          line: location ? numeric(location.line, `${at}/location/line`, true) : null,
          column: location ? numeric(location.column, `${at}/location/column`, true) : null,
        },
      };
    });
    const errors: string[] = [];
    const message = optionalString(row.message);
    if (row.testExecError !== undefined && row.testExecError !== null) {
      const exec = object(row.testExecError, `${pointer}/testExecError`);
      errors.push(optionalString(exec.stack) ?? optionalString(exec.message) ?? "Runner reported a suite execution error.");
    } else if (message && (format === "vitest" || (rawStatus === "failed" && !tests.some(test => test.status === "failed")))) {
      errors.push(message);
    }
    if (rawStatus === "failed" && tests.every(test => test.status !== "failed") && errors.length === 0) {
      errors.push("Runner reported a suite failure without assertion failure details.");
    }
    if (rawStatus === "passed" && (tests.some(test => test.status === "failed") || errors.length > 0)) {
      issues.push(issue("contradictory_status", "Suite claims passed but contains failure evidence.", pointer));
    }
    if (rawStatus === null || !["passed", "failed", "pending", "skipped"].includes(rawStatus)) {
      issues.push(issue("unknown_suite_status", "Suite has an unsupported or missing status.", pointer));
    }
    return { id: String(si), name, parentId: null, rawStatus, durationMs: elapsed(row.startTime, row.endTime, pointer), tests, errors, source: pointer };
  });
  const counts = countTests(suites.flatMap(suite => suite.tests));
  const pending = counts.skipped + (format === "vitest"
    ? suites.flatMap(suite => suite.tests).filter(test => test.rawStatus === "pending").length : 0);
  for (const [key, actual] of Object.entries({
    numTotalTests: counts.total, numPassedTests: counts.passed,
    numFailedTests: counts.failed, numPendingTests: pending, numTodoTests: counts.todo,
  })) checkTotal(totals, key, data[key], actual, issues);
  if (format === "jest") {
    for (const [key, actual] of Object.entries({
      numTotalTestSuites: suites.length,
      numPassedTestSuites: suites.filter(suite => suite.rawStatus === "passed").length,
      numFailedTestSuites: suites.filter(suite => suite.rawStatus === "failed").length,
      numPendingTestSuites: suites.filter(suite => ["pending", "skipped"].includes(suite.rawStatus ?? "")).length,
      numRuntimeErrorTestSuites: suites.filter(suite => suite.errors.length > 0).length,
    })) checkTotal(totals, key, data[key], actual, issues);
  } else {
    // Vitest counts describe blocks as suites but emits only file rows. Do not compare these to file count.
    const keys = ["numTotalTestSuites", "numPassedTestSuites", "numFailedTestSuites", "numPendingTestSuites"];
    const values = keys.map(key => numeric(data[key], key, true));
    values.forEach((value, index) => { if (value !== null) totals[`report.${keys[index]}`] = value; });
    const [total, passed, failed, pendingSuites] = values;
    if (total != null && passed != null && failed != null && pendingSuites != null && total !== passed + failed + pendingSuites) {
      issues.push(issue("contradictory_total", "Vitest's logical suite totals do not add up."));
    }
    if (total != null && total < suites.length) issues.push(issue("contradictory_total", "Vitest declares fewer logical suites than file rows."));
  }
  if (data.success !== undefined && typeof data.success !== "boolean") throw new ReportError("invalid_report", "success must be a boolean.");
  if (data.wasInterrupted !== undefined && typeof data.wasInterrupted !== "boolean") throw new ReportError("invalid_report", "wasInterrupted must be a boolean.");
  const suiteErrors = suites.reduce((sum, suite) => sum + suite.errors.length, 0);
  if (data.success === true && (counts.failed > 0 || suiteErrors > 0)) {
    issues.push(issue("contradictory_status", "Report claims success but contains failure evidence."));
  }
  return {
    format, suites, counts, suiteErrors, issues, startedAt: timestamp(data.startTime),
    durationMs: elapsed(data.startTime, data.endTime, "report"),
    interrupted: data.wasInterrupted === true,
    reportedSuccess: typeof data.success === "boolean" ? data.success : null,
    reportedTotals: totals,
  };
}

function boundedReport(report: ParsedReport): ParsedReport {
  const pending: unknown[] = [report];
  let bytes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      bytes += 2 + value.length;
      for (const item of value) pending.push(item);
    } else if (value !== null && typeof value === "object") {
      bytes += 2;
      for (const [key, item] of Object.entries(value)) {
        bytes += Buffer.byteLength(JSON.stringify(key)) + 2;
        pending.push(item);
      }
    } else if (value !== undefined) {
      bytes += Buffer.byteLength(JSON.stringify(value));
    }
    if (bytes > 24 * 1024 * 1024) throw new ReportError("report_too_large", "Normalized report exceeds the 24 MiB expansion budget.");
  }
  return report;
}

export function normalizeReport(format: Format, text: string): ParsedReport {
  if (!FORMATS.includes(format)) throw new ReportError("unsupported_format", "Use jest, vitest, or junit; console output and Playwright JSON are not supported.");
  if (Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) throw new ReportError("report_too_large", "Report exceeds the 16 MiB limit.");
  if (!text.trim()) throw new ReportError("empty_report", "Report is empty; no test outcomes can be inferred.");
  if (format === "junit") return boundedReport(parseJUnit(text));
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ReportError("malformed_json", "Report is not valid JSON; it may be truncated or contain console output.");
  }
  return boundedReport(parseJsonReport(format, json));
}
