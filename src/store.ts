import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import {
  SCHEMA_VERSION, ReportError, classify, countTests, issue, object, unavailableCoverage,
} from "./model.js";
import type { Dataset, Run, RunSummary, Scope } from "./model.js";
import { importInput, prepareInput, readInput, runId } from "./inputs.js";
import { atomicJson, hasCode, inside, privateDirectory, readEvidence } from "./files.js";
import { normalizeReport } from "./adapters.js";
import { parseCoverage } from "./coverage.js";
import { isRun } from "./validation.js";

const execFileAsync = promisify(execFile);
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function storedRun(value: unknown): Run {
  const row = object(value, "stored run");
  if (row.schemaVersion !== SCHEMA_VERSION) throw new ReportError("unsupported_schema", "Stored run uses an unsupported schema version.");
  if (!isRun(row)) throw new ReportError("corrupt_evidence", "Stored evidence does not match the normalized run contract.");
  runId(row.id);
  const run = row;
  if (run.report) {
    const counts = countTests(run.report.suites.flatMap(suite => suite.tests));
    if (Object.entries(counts).some(([key, value]) => run.report?.counts[key as keyof typeof counts] !== value) ||
        run.report.suiteErrors !== run.report.suites.reduce((sum, suite) => sum + suite.errors.length, 0)) {
      throw new ReportError("corrupt_evidence", "Stored totals disagree with stored test evidence.");
    }
  }
  if (classify(run) !== run.state) throw new ReportError("corrupt_evidence", "Stored state disagrees with its evidence.");
  return run;
}

export interface StoreOptions {
  workspacePath: string | undefined;
  cwd: string;
}

export class ReportStore {
  private constructor(readonly workspace: string, readonly scope: Scope, readonly cwd: string) {}

  static async create({ workspacePath, cwd }: StoreOptions): Promise<ReportStore> {
    if (!workspacePath || !isAbsolute(workspacePath)) {
      throw new ReportError("workspace_unavailable", "The SDK session workspace is unavailable. Enable session workspaces; no global or plugin-cache fallback is used.");
    }
    const workspace = await realpath(workspacePath);
    if (!(await lstat(workspace)).isDirectory()) throw new ReportError("workspace_unavailable", "SDK session workspace is not a directory.");
    const directory = await realpath(cwd);
    let output: string;
    try {
      ({ stdout: output } = await execFileAsync("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
        timeout: 10_000, maxBuffer: 32 * 1024,
      }));
    } catch {
      throw new ReportError("repository_unavailable", "Cannot identify the active Git worktree. Open the plugin in a Git repository.");
    }
    const [root, common] = output.trim().split("\n");
    if (!root || !common || !isAbsolute(root) || !isAbsolute(common)) {
      throw new ReportError("repository_unavailable", "Git did not return an unambiguous worktree identity.");
    }
    const worktree = await realpath(root);
    if (inside(worktree, workspace)) throw new ReportError("unsafe_workspace", "SDK evidence storage must be outside the repository.");
    const repositoryId = hash(common);
    const worktreeId = hash(worktree);
    const scope = { id: `${repositoryId}-${worktreeId}`, repositoryId, worktreeId, repositoryName: basename(worktree), worktreePath: worktree };
    const store = new ReportStore(workspace, scope, directory);
    await privateDirectory(workspace, store.root);
    return store;
  }

  get root(): string {
    return join(this.workspace, "files", "test-lab", `v${SCHEMA_VERSION}`, this.scope.id);
  }

  get openCanvas(): { canvasId: string; instanceId: string; input: { scopeId: string } } {
    return { canvasId: "test-dashboard", instanceId: `test-lab-${this.scope.id}`, input: { scopeId: this.scope.id } };
  }

  paths(id: string, format: Run["format"]) {
    const directory = join(this.root, runId(id));
    const inputDirectory = join(directory, "input");
    const coverageDirectory = join(inputDirectory, "coverage");
    return {
      directory, inputDirectory, coverageDirectory,
      reportPath: join(inputDirectory, `report.${format === "junit" ? "xml" : "json"}`),
      coveragePath: join(coverageDirectory, "coverage-summary.json"),
      normalizedPath: join(directory, "normalized.json"),
    };
  }

  async prepare(value: unknown) {
    const input = prepareInput(value);
    const workingDirectory = await realpath(resolve(this.cwd, input.workingDirectory ?? "."));
    if (!inside(this.scope.worktreePath, workingDirectory) || !(await lstat(workingDirectory)).isDirectory()) {
      throw new ReportError("unsafe_path", "Test workingDirectory must be inside the active worktree.");
    }
    const id = randomUUID();
    const paths = this.paths(id, input.format);
    await privateDirectory(this.workspace, paths.coverageDirectory);
    await privateDirectory(this.workspace, join(paths.directory, "raw"));
    const run: Run = {
      schemaVersion: SCHEMA_VERSION, id, scope: this.scope,
      format: input.format, runnerName: input.runnerName ?? null, runnerVersion: input.runnerVersion ?? null,
      command: input.command, workingDirectory,
      preparedAt: new Date().toISOString(), evidenceStartedAt: input.evidenceStartedAt ?? null,
      importedAt: null, completion: "pending",
      exitCode: null, state: "awaiting-report", source: null, report: null,
      coverage: unavailableCoverage(), issues: [],
    };
    await atomicJson(this.workspace, join(paths.directory, "prepared.json"), run);
    return {
      runId: id, scope: this.scope, ...paths, openCanvas: this.openCanvas,
      note: "No tests were started. Run the requested command through normal host shell tools, then import even when it fails. Paths belong only to this run.",
    };
  }

  private async load(id: string): Promise<Run> {
    const dir = join(this.root, runId(id));
    await privateDirectory(this.workspace, this.root);
    let evidence;
    try {
      evidence = await readEvidence(join(dir, "normalized.json"), [this.root], 64 * 1024 * 1024);
    } catch (error) {
      if (!(error instanceof ReportError) || error.code !== "missing_report") throw error;
      evidence = await readEvidence(join(dir, "prepared.json"), [this.root]);
    }
    let value: unknown;
    try {
      value = JSON.parse(evidence.text);
    } catch {
      throw new ReportError("corrupt_evidence", "Stored evidence is malformed JSON.");
    }
    const run = storedRun(value);
    if (run.id !== id || run.scope.id !== this.scope.id || run.scope.worktreePath !== this.scope.worktreePath) {
      throw new ReportError("scope_mismatch", "Stored evidence belongs to a different worktree or run.");
    }
    return run;
  }

  async read(value: unknown = {}): Promise<Dataset> {
    const input = readInput(value);
    await privateDirectory(this.workspace, this.root);
    const dirs = await readdir(this.root, { withFileTypes: true });
    const runs: RunSummary[] = [];
    for (const dir of dirs) {
      if (!/^[a-f0-9-]{36}$/.test(dir.name)) continue;
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw new ReportError("unsafe_path", "Invalid run directory in session storage.");
      const run = await this.load(dir.name);
      runs.push({ id: run.id, format: run.format, preparedAt: run.preparedAt, state: run.state, counts: run.report?.counts ?? null });
    }
    runs.sort((a, b) => b.preparedAt.localeCompare(a.preparedAt) || b.id.localeCompare(a.id));
    const selected = input.runId ?? runs[0]?.id;
    return { schemaVersion: SCHEMA_VERSION, scope: this.scope, runs, run: selected ? await this.load(selected) : null };
  }

  async importReport(value: unknown): Promise<Run> {
    const input = importInput(value);
    const run = await this.load(input.runId);
    if (run.importedAt !== null) throw new ReportError("already_imported", "This run is finalized. Prepare a new run instead of overwriting evidence.");
    const paths = this.paths(run.id, run.format);
    await privateDirectory(this.workspace, paths.directory);
    const lockPath = join(paths.directory, "import.lock");
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (hasCode(error, "EEXIST")) throw new ReportError("run_busy", "An import lock exists. If an earlier importer crashed, prepare a new run; evidence is not overwritten.");
      throw error;
    }
    try {
      if ((await this.load(input.runId)).importedAt !== null) throw new ReportError("already_imported", "This run has already been finalized.");
      run.completion = input.completion;
      run.exitCode = input.exitCode;
      run.command = input.executedCommand ?? run.command;
      run.importedAt = new Date().toISOString();
      try {
        const reportPath = resolve(run.workingDirectory, input.reportPath ?? paths.reportPath);
        if (extname(reportPath).toLowerCase() !== (run.format === "junit" ? ".xml" : ".json")) {
          throw new ReportError("unsafe_path", "Report file extension must match the selected JSON/XML format.");
        }
        const evidence = await readEvidence(reportPath, [this.workspace, this.scope.worktreePath]);
        if (Date.parse(evidence.source.modifiedAt) < Date.parse(run.evidenceStartedAt ?? run.preparedAt) - 1000) {
          throw new ReportError("stale_report", "Report predates this run. Write fresh reporter output to its prepared path.");
        }
        run.source = evidence.source;
        await privateDirectory(this.workspace, join(paths.directory, "raw"));
        await writeFile(join(paths.directory, "raw", `report.${run.format === "junit" ? "xml" : "json"}`), evidence.bytes, { flag: "wx", mode: 0o600 });
        run.report = normalizeReport(run.format, evidence.text);
        run.issues.push(...run.report.issues);
      } catch (error) {
        if (!(error instanceof ReportError)) throw error;
        run.issues.push(issue(error.code, error.message));
      }
      if (input.coveragePath) {
        try {
          const coveragePath = resolve(run.workingDirectory, input.coveragePath);
          if (coveragePath !== paths.coveragePath) throw new ReportError("stale_coverage", "Only this run's prepared coverage-summary.json is accepted. Existing repository coverage is not reused.");
          const coverage = await readEvidence(coveragePath, [paths.coverageDirectory]);
          if (Date.parse(coverage.source.modifiedAt) < Date.parse(run.evidenceStartedAt ?? run.preparedAt) - 1000) throw new ReportError("stale_coverage", "Coverage predates this run.");
          await privateDirectory(this.workspace, join(paths.directory, "raw"));
          await writeFile(join(paths.directory, "raw", "coverage-summary.json"), coverage.bytes, { flag: "wx", mode: 0o600 });
          run.coverage = parseCoverage(coverage.text, coverage.source);
        } catch (error) {
          if (!(error instanceof ReportError)) throw error;
          run.coverage = unavailableCoverage(error.message);
          run.issues.push(issue(error.code, error.message, "coverage", "warning"));
        }
      }
      if (run.completion === "completed" && run.exitCode === null) run.issues.push(issue("unknown_exit", "Process exit code was not observed."));
      if (run.report?.interrupted || run.completion === "interrupted") run.issues.push(issue("interrupted", "Execution was interrupted; reported rows may be only a partial result."));
      if (run.exitCode !== null && run.exitCode !== 0) run.issues.push(issue("process_exit", `Process exited with code ${run.exitCode}; see reporter evidence or the host command output.`, "execution", "warning"));
      run.state = classify(run);
      await atomicJson(this.workspace, paths.normalizedPath, run);
      return run;
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
