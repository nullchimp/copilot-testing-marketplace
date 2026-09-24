import { FORMATS, ReportError, object } from "./model.js";
import type { Completion, Format } from "./model.js";

export interface PrepareInput {
  format: Format;
  command: string;
  workingDirectory?: string;
  runnerVersion?: string;
  runnerName?: string;
  evidenceStartedAt?: string;
}

export interface ImportInput {
  runId: string;
  reportPath?: string;
  coveragePath?: string;
  exitCode: number | null;
  completion: Exclude<Completion, "pending">;
  executedCommand?: string;
}

const pathProperty = { type: "string", minLength: 1, maxLength: 4096 };
const runIdProperty = { type: "string", pattern: "^[a-f0-9-]{36}$" };
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const objectSchema = (properties: Record<string, JsonValue>, required: string[] = []) => ({
  type: "object", additionalProperties: false, properties, required,
});

export const schemas = {
  prepare: objectSchema({
    format: { type: "string", enum: [...FORMATS] },
    command: { type: "string", minLength: 1, maxLength: 16384 },
    workingDirectory: pathProperty, runnerVersion: { type: "string", minLength: 1, maxLength: 100 },
    runnerName: { type: "string", minLength: 1, maxLength: 100 },
    evidenceStartedAt: { type: "string", description: "Only for importing an already-recorded run: its observed ISO start time from host execution metadata. Otherwise omit." },
  }, ["format", "command"]),
  import: objectSchema({
    runId: runIdProperty, reportPath: pathProperty, coveragePath: pathProperty,
    exitCode: { type: ["integer", "null"], minimum: 0, maximum: 4294967295 },
    completion: { type: "string", enum: ["completed", "interrupted", "unknown"] },
    executedCommand: { type: "string", minLength: 1, maxLength: 16384, description: "Actual host command, including selected reporter flags; excludes credentials." },
  }, ["runId", "exitCode", "completion"]),
  read: objectSchema({ runId: runIdProperty }),
  open: objectSchema({ scopeId: { type: "string", pattern: "^[a-f0-9]{16}-[a-f0-9]{16}$" } }, ["scopeId"]),
  empty: objectSchema({}),
};

export function inputObject(value: unknown, allowed: string[]): Record<string, unknown> {
  let result: Record<string, unknown>;
  try {
    result = object(value, "input");
  } catch (error) {
    if (!(error instanceof ReportError)) throw error;
    throw new ReportError("invalid_input", error.message);
  }
  if (Object.keys(result).some(key => !allowed.includes(key))) {
    throw new ReportError("invalid_input", "Input contains an unsupported property.");
  }
  return result;
}

export function inputString(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new ReportError("invalid_input", `${label} must be a nonempty string of at most ${max} characters.`);
  }
  return value;
}

export function runId(value: unknown): string {
  const id = inputString(value, "runId", 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) {
    throw new ReportError("invalid_input", "runId must be the UUID returned by prepare_run.");
  }
  return id;
}

export function prepareInput(value: unknown): PrepareInput {
  const data = inputObject(value, ["format", "command", "workingDirectory", "runnerVersion", "runnerName", "evidenceStartedAt"]);
  if (typeof data.format !== "string" || !FORMATS.includes(data.format as Format)) {
    throw new ReportError("unsupported_format", "Supported formats are jest, vitest, and junit.");
  }
  let evidenceStartedAt: string | undefined;
  if (data.evidenceStartedAt !== undefined) {
    const text = inputString(data.evidenceStartedAt, "evidenceStartedAt", 100);
    const time = Date.parse(text);
    if (!/^\d{4}-\d\d-\d\dT/.test(text) || !Number.isFinite(time) || time > Date.now() + 1000) {
      throw new ReportError("invalid_input", "evidenceStartedAt must be an observed ISO timestamp, not a future time.");
    }
    evidenceStartedAt = new Date(time).toISOString();
  }
  return {
    format: data.format as Format, command: inputString(data.command, "command", 16384),
    ...(data.workingDirectory === undefined ? {} : { workingDirectory: inputString(data.workingDirectory, "workingDirectory") }),
    ...(data.runnerVersion === undefined ? {} : { runnerVersion: inputString(data.runnerVersion, "runnerVersion", 100) }),
    ...(data.runnerName === undefined ? {} : { runnerName: inputString(data.runnerName, "runnerName", 100) }),
    ...(evidenceStartedAt === undefined ? {} : { evidenceStartedAt }),
  };
}

export function importInput(value: unknown): ImportInput {
  const data = inputObject(value, ["runId", "reportPath", "coveragePath", "exitCode", "completion", "executedCommand"]);
  if (data.exitCode !== null && (typeof data.exitCode !== "number" || !Number.isSafeInteger(data.exitCode) || data.exitCode < 0 || data.exitCode > 4294967295)) {
    throw new ReportError("invalid_input", "exitCode must be the observed nonnegative process exit code, or null when unknown.");
  }
  if (data.completion !== "completed" && data.completion !== "interrupted" && data.completion !== "unknown") {
    throw new ReportError("invalid_input", "completion must be completed, interrupted, or unknown.");
  }
  return {
    runId: runId(data.runId), exitCode: data.exitCode, completion: data.completion,
    ...(data.reportPath === undefined ? {} : { reportPath: inputString(data.reportPath, "reportPath") }),
    ...(data.coveragePath === undefined ? {} : { coveragePath: inputString(data.coveragePath, "coveragePath") }),
    ...(data.executedCommand === undefined ? {} : { executedCommand: inputString(data.executedCommand, "executedCommand", 16384) }),
  };
}

export function readInput(value: unknown): { runId?: string } {
  const data = inputObject(value, ["runId"]);
  return data.runId === undefined ? {} : { runId: runId(data.runId) };
}
