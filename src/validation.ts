import type { Counts, Coverage, CoverageMetric, Issue, ParsedReport, Provenance, Run, Scope, Suite, TestCase } from "./model.js";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const maybeText = (value: unknown): value is string | null => value === null || text(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => number(value) && Number.isSafeInteger(value);
const maybeNumber = (value: unknown): value is number | null => value === null || number(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const isIssue = (value: unknown): value is Issue => record(value) && text(value.code) && text(value.message) &&
  text(value.source) && (value.severity === "warning" || value.severity === "error");
const isCounts = (value: unknown): value is Counts => record(value) &&
  ["total", "passed", "failed", "skipped", "todo", "error", "unknown"].every(key => integer(value[key]));
const isProvenance = (value: unknown): value is Provenance => record(value) &&
  text(value.path) && text(value.sha256) && /^[a-f0-9]{64}$/.test(value.sha256) && integer(value.bytes) && text(value.modifiedAt);
const isMetric = (value: unknown): value is CoverageMetric => record(value) &&
  integer(value.total) && integer(value.covered) && value.covered <= value.total &&
  (value.skipped === null || integer(value.skipped)) && maybeNumber(value.percent) && maybeNumber(value.reportedPercent);
const isCoverage = (value: unknown): value is Coverage => record(value) &&
  (value.status === "available" || value.status === "unavailable") && maybeText(value.reason) &&
  (value.source === null || isProvenance(value.source)) && record(value.metrics) &&
  ["lines", "branches", "functions", "statements"].every(key => {
    const metrics = value.metrics;
    return record(metrics) && (metrics[key] === null || isMetric(metrics[key]));
  });
const isScope = (value: unknown): value is Scope => record(value) &&
  ["id", "repositoryId", "worktreeId", "repositoryName", "worktreePath"].every(key => text(value[key]));
const isTest = (value: unknown): value is TestCase => record(value) && text(value.id) && text(value.name) &&
  text(value.fullName) && strings(value.ancestors) && maybeText(value.rawStatus) && text(value.status) &&
  ["passed", "failed", "skipped", "todo", "error", "unknown"].includes(value.status) &&
  maybeNumber(value.durationMs) && strings(value.messages) && record(value.source) &&
  text(value.source.pointer) && maybeText(value.source.file) &&
  (value.source.line === null || integer(value.source.line)) &&
  (value.source.column === null || integer(value.source.column));
const isSuite = (value: unknown): value is Suite => record(value) && text(value.id) && text(value.name) &&
  maybeText(value.parentId) && maybeText(value.rawStatus) && maybeNumber(value.durationMs) &&
  text(value.source) && strings(value.errors) && Array.isArray(value.tests) && value.tests.every(isTest);
const isReport = (value: unknown): value is ParsedReport => record(value) && text(value.format) &&
  ["jest", "vitest", "junit"].includes(value.format) && Array.isArray(value.suites) && value.suites.every(isSuite) &&
  isCounts(value.counts) && integer(value.suiteErrors) && Array.isArray(value.issues) && value.issues.every(isIssue) &&
  maybeText(value.startedAt) && maybeNumber(value.durationMs) && typeof value.interrupted === "boolean" &&
  (value.reportedSuccess === null || typeof value.reportedSuccess === "boolean") &&
  record(value.reportedTotals) && Object.values(value.reportedTotals).every(integer);

export const isRun = (value: unknown): value is Run => record(value) &&
  value.schemaVersion === 1 && text(value.id) && isScope(value.scope) && text(value.format) &&
  ["jest", "vitest", "junit"].includes(value.format) && maybeText(value.runnerVersion) &&
  (value.runnerName === undefined || maybeText(value.runnerName)) &&
  text(value.command) && text(value.workingDirectory) && text(value.preparedAt) &&
  maybeText(value.evidenceStartedAt) && maybeText(value.importedAt) && text(value.completion) &&
  ["pending", "completed", "interrupted", "unknown"].includes(value.completion) &&
  (value.exitCode === null || integer(value.exitCode)) && text(value.state) &&
  ["awaiting-report", "passed", "failed", "incomplete", "error", "empty"].includes(value.state) &&
  (value.report === null || isReport(value.report)) && (value.source === null || isProvenance(value.source)) &&
  isCoverage(value.coverage) && Array.isArray(value.issues) && value.issues.every(isIssue);
