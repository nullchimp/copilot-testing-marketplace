export const SCHEMA_VERSION = 1 as const;
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
export const MAX_TESTS = 50_000;
export const FORMATS = ["jest", "vitest", "junit"] as const;
export type Format = (typeof FORMATS)[number];
export type Status = "passed" | "failed" | "skipped" | "todo" | "error" | "unknown";
export type Completion = "pending" | "completed" | "interrupted" | "unknown";
export type RunState = "awaiting-report" | "passed" | "failed" | "incomplete" | "error" | "empty";

export class ReportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReportError";
  }
}

export interface Issue {
  code: string;
  message: string;
  severity: "warning" | "error";
  source: string;
}

export interface Counts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  error: number;
  unknown: number;
}

export interface TestCase {
  id: string;
  name: string;
  fullName: string;
  ancestors: string[];
  status: Status;
  rawStatus: string | null;
  durationMs: number | null;
  messages: string[];
  source: { pointer: string; file: string | null; line: number | null; column: number | null };
}

export interface Suite {
  id: string;
  name: string;
  parentId: string | null;
  rawStatus: string | null;
  durationMs: number | null;
  tests: TestCase[];
  errors: string[];
  source: string;
}

export interface ParsedReport {
  format: Format;
  suites: Suite[];
  counts: Counts;
  suiteErrors: number;
  issues: Issue[];
  startedAt: string | null;
  durationMs: number | null;
  interrupted: boolean;
  reportedSuccess: boolean | null;
  reportedTotals: Record<string, number>;
}

export interface Provenance {
  path: string;
  sha256: string;
  bytes: number;
  modifiedAt: string;
}

export interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number | null;
  percent: number | null;
  reportedPercent: number | null;
}

export interface Coverage {
  status: "available" | "unavailable";
  reason: string | null;
  source: Provenance | null;
  metrics: Record<"lines" | "branches" | "functions" | "statements", CoverageMetric | null>;
}

export interface Scope {
  id: string;
  repositoryId: string;
  worktreeId: string;
  repositoryName: string;
  worktreePath: string;
}

export interface Run {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  scope: Scope;
  format: Format;
  runnerName?: string | null;
  runnerVersion: string | null;
  command: string;
  workingDirectory: string;
  preparedAt: string;
  evidenceStartedAt: string | null;
  importedAt: string | null;
  completion: Completion;
  exitCode: number | null;
  state: RunState;
  report: ParsedReport | null;
  source: Provenance | null;
  coverage: Coverage;
  issues: Issue[];
}

export interface RunSummary {
  id: string;
  format: Format;
  preparedAt: string;
  state: RunState;
  counts: Counts | null;
}

export interface Dataset {
  schemaVersion: typeof SCHEMA_VERSION;
  scope: Scope;
  runs: RunSummary[];
  run: Run | null;
}

export function emptyCounts(): Counts {
  return { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0, error: 0, unknown: 0 };
}

export function countTests(tests: TestCase[]): Counts {
  const counts = emptyCounts();
  for (const test of tests) {
    counts.total++;
    counts[test.status]++;
  }
  return counts;
}

export function issue(code: string, message: string, source = "report", severity: Issue["severity"] = "error"): Issue {
  return { code, message, source, severity };
}

export function unavailableCoverage(reason = "No current-run Istanbul coverage summary was supplied."): Coverage {
  return {
    status: "unavailable",
    reason,
    source: null,
    metrics: { lines: null, branches: null, functions: null, statements: null },
  };
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReportError("invalid_report", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_TESTS) {
    throw new ReportError("invalid_report", `${label} must be an array with at most ${MAX_TESTS} entries.`);
  }
  return value;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ReportError("invalid_report", `${label} must be a string.`);
  return value;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function numeric(value: unknown, label: string, integer = false): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new ReportError("invalid_report", `${label} must be a nonnegative ${integer ? "integer" : "number"} or absent.`);
  }
  return value;
}

export function checkTotal(
  totals: Record<string, number>, key: string, value: unknown, actual: number,
  issues: Issue[], source = "report",
): void {
  const count = numeric(value, `${source}.${key}`, true);
  if (count === null) return;
  totals[`${source}.${key}`] = count;
  if (count !== actual) {
    issues.push(issue("contradictory_total", `${key} declares ${count}; parsed evidence contains ${actual}.`, source));
  }
}

export function classify(run: Run): RunState {
  if (run.report === null) return run.importedAt === null ? "awaiting-report" : "error";
  if (run.completion !== "completed" || run.report.interrupted ||
      run.issues.some(item => item.severity === "error") || run.report.counts.unknown > 0) return "incomplete";
  if (run.report.counts.failed > 0 || run.report.counts.error > 0 ||
      run.report.suiteErrors > 0 || (run.exitCode !== null && run.exitCode !== 0) ||
      run.report.reportedSuccess === false) return "failed";
  if (run.exitCode === null) return "incomplete";
  if (run.report.counts.passed === 0) return "empty";
  return "passed";
}
