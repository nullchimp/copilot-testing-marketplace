const $ = id => document.getElementById(id);
const pageSize = 100;
let data;
let selected;
let page = 0;
let request = 0;
let abort;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function badge(text) {
  const element = node("span", text, "badge");
  element.dataset.state = text;
  return element;
}
function duration(ms) {
  return ms === null ? "Duration unknown" : `${ms.toLocaleString(undefined, { maximumFractionDigits: 2 })} ms`;
}
function fatal(message) {
  $("fatal").textContent = message;
  $("fatal").hidden = false;
  $("connection").textContent = "Evidence unavailable. Previously displayed results are not current.";
  $("run").hidden = true;
  $("empty").hidden = true;
}
const stateMessages = {
  "awaiting-report": "No final report has been imported. Execution is not confirmed; this run may be pending, in progress, or interrupted. No passing outcome is implied.",
  passed: "The observed process exited successfully and the available reporter evidence has no failures or completeness errors.",
  failed: "The report or process contains failure evidence. A failing test run is not an importer failure.",
  incomplete: "Evidence is incomplete or contradictory. Counts below describe only parsed rows, not a successful complete run.",
  error: "No usable reporter evidence was imported. Missing, malformed, unsupported, or unsafe input is never treated as a pass.",
  empty: "No passing or failing test execution was reported. An empty or entirely skipped/todo run is not an all-green success.",
};

function render() {
  const run = data.run;
  $("fatal").hidden = true;
  $("connection").textContent = `Local session evidence / ${data.scope.repositoryName}`;
  $("history").replaceChildren();
  if (!data.runs.length) $("history").append(node("option", "No recorded runs"));
  for (const record of data.runs) {
    const option = node("option", `${record.preparedAt} / ${record.format} / ${record.state} / ${record.id.slice(0, 8)}`);
    option.value = record.id;
    option.selected = record.id === run?.id;
    $("history").append(option);
  }
  $("history").disabled = data.runs.length === 0;
  $("run").hidden = !run;
  $("empty").hidden = Boolean(run);
  if (!run) { acknowledge(null, 0); return; }
  $("run-title").textContent = `${run.format} results`;
  $("run-state").textContent = run.state;
  $("run-state").dataset.state = run.state;
  $("state-detail").textContent = stateMessages[run.state] ?? "Unknown evidence state.";
  $("metadata").replaceChildren();
  for (const [label, value] of [
    ["Worktree", run.scope.worktreePath], ["Command", run.command], ["Working dir", run.workingDirectory],
    ["Format", run.format], ["Runner", `${run.runnerName ?? "Unknown runner"}${run.runnerVersion ? ` ${run.runnerVersion}` : " (version unknown)"}`],
    ["Prepared", run.preparedAt], ["Recorded start", run.evidenceStartedAt ?? "Not supplied"], ["Reported start", run.report?.startedAt ?? "Unknown"],
    ["Imported", run.importedAt ?? "Not imported"], ["Exit code", run.exitCode ?? "Unknown"],
    ["Completion", run.completion], ["Run duration", duration(run.report?.durationMs ?? null)],
  ]) $("metadata").append(node("dt", label), node("dd", value));
  $("totals").replaceChildren();
  for (const [label, value] of [
    ["Tests", run.report?.counts.total], ["Passed", run.report?.counts.passed],
    ["Failed", run.report?.counts.failed], ["Skipped", run.report?.counts.skipped],
    ["Todo", run.report?.counts.todo], ["Test errors", run.report?.counts.error],
    ["Unknown", run.report?.counts.unknown], ["Suite errors", run.report?.suiteErrors],
  ]) {
    const metric = node("div", undefined, "metric");
    metric.append(node("strong", value ?? "Unknown"), node("span", label));
    $("totals").append(metric);
  }
  $("issues").replaceChildren(...run.issues.slice(0, 100).map(item => node("li", `${item.severity}: ${item.message} [${item.code}; ${item.source}]`)));
  if (run.issues.length > 100) $("issues").append(node("li", `Showing 100 of ${run.issues.length} notes. All notes remain in the normalized artifact.`));
  $("issues-section").hidden = run.issues.length === 0;
  $("suite-errors").replaceChildren();
  let errorCount = 0;
  for (const suite of run.report?.suites ?? []) {
    for (const message of suite.errors) {
      if (++errorCount > 100) continue;
      const block = node("div", undefined, "suite-error");
      block.append(node("strong", suite.name), node("pre", message));
      $("suite-errors").append(block);
    }
    if (errorCount > 100) $("suite-errors").append(node("p", `Showing 100 of ${errorCount} suite errors. All details remain in the normalized artifact.`, "muted"));
  }
  $("suite-errors-section").hidden = !$("suite-errors").children.length;
  $("coverage").replaceChildren();
  if (run.coverage.status !== "available") {
    $("coverage").append(node("p", run.coverage.reason, "muted"));
  } else {
    const grid = node("div", undefined, "coverage-grid");
    for (const [key, metric] of Object.entries(run.coverage.metrics)) {
      const block = node("div", undefined, "metric");
      block.append(node("strong", metric?.percent === null || !metric ? "N/A" : `${metric.percent.toFixed(2)}%`),
        node("span", key), node("p", metric ? `${metric.covered} / ${metric.total}${metric.total === 0 ? " (empty denominator)" : ""}` : "Not reported", "small"));
      grid.append(block);
    }
    $("coverage").append(grid);
  }
  $("provenance").textContent = JSON.stringify({
    schemaVersion: run.schemaVersion, runId: run.id, source: run.source, coverage: run.coverage.source,
    reportedTotals: run.report?.reportedTotals ?? null,
    note: "Derived test counts exclude suite errors. Raw source statuses and source pointers are retained per row.",
  }, null, 2);
  const slow = rows().filter(row => row.test.durationMs !== null).sort((a, b) => b.test.durationMs - a.test.durationMs).slice(0, 10);
  $("slow").replaceChildren(...slow.map(row => node("li", `${row.test.fullName} / ${duration(row.test.durationMs)}`)));
  if (!slow.length) $("slow").append(node("li", "No test durations were reported."));
  renderTests();
}

function rows() {
  return (data?.run?.report?.suites ?? []).flatMap(suite => suite.tests.map(test => ({ suite, test })));
}
function renderTests() {
  const query = $("search").value.toLocaleLowerCase();
  const status = $("status").value;
  const filtered = rows().filter(({ suite, test }) =>
    (status === "all" || test.status === status) &&
    `${suite.name}\n${test.fullName}\n${test.messages.join("\n")}`.toLocaleLowerCase().includes(query));
  if ($("order").value === "slow") filtered.sort((a, b) => (b.test.durationMs ?? -1) - (a.test.durationMs ?? -1));
  page = Math.max(0, Math.min(page, Math.ceil(filtered.length / pageSize) - 1));
  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
  $("matching").textContent = `${filtered.length} matching tests / ${data?.run?.report?.suites.length ?? 0} normalized suites/groups`;
  $("tests").replaceChildren();
  for (const { suite, test } of visible) {
    const details = node("details", undefined, "test");
    const summary = node("summary");
    summary.append(node("span", suite.name, "test-suite"), badge(test.status), document.createTextNode(`${test.fullName} / ${duration(test.durationMs)}`));
    const body = node("div", undefined, "test-body");
    body.append(node("p", `Raw status: ${test.rawStatus ?? "not reported (JUnit outcome inferred from elements)"} / ID: ${test.id}`, "muted"));
    for (const message of test.messages) body.append(node("pre", message));
    if (!test.messages.length) body.append(node("p", "No failure or skip details were reported.", "muted"));
    body.append(node("pre", JSON.stringify(test.source, null, 2)));
    details.append(summary, body);
    $("tests").append(details);
  }
  if (!visible.length) $("tests").append(node("p", data?.run?.report ? "No test rows match these filters." : "No parsed test rows available.", "muted"));
  $("previous").disabled = page === 0;
  $("next").disabled = (page + 1) * pageSize >= filtered.length;
  $("page").textContent = `Page ${page + 1} / ${Math.max(1, Math.ceil(filtered.length / pageSize))}`;
  acknowledge(data?.run?.id ?? null, visible.length);
}
async function acknowledge(runId, testRows) {
  try {
    const response = await fetch("api/rendered", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, testRows }),
    });
    if (!response.ok) throw new Error(`Render acknowledgement failed (${response.status}).`);
  } catch (error) {
    $("connection").textContent = `Evidence rendered; connection acknowledgement unavailable: ${error.message}`;
  }
}
async function load() {
  const id = ++request;
  abort?.abort();
  abort = new AbortController();
  $("connection").textContent = "Loading recorded evidence...";
  try {
    const response = await fetch(`api/state${selected ? `?runId=${encodeURIComponent(selected)}` : ""}`, { signal: abort.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? `Evidence request failed (${response.status}).`);
    if (id !== request) return;
    data = result;
    render();
  } catch (error) {
    if (error.name !== "AbortError" && id === request) fatal(error.message);
  }
}
$("refresh").addEventListener("click", load);
$("history").addEventListener("change", () => { selected = $("history").value; page = 0; load(); });
for (const id of ["search", "status", "order"]) $(id).addEventListener("input", () => { page = 0; renderTests(); });
$("previous").addEventListener("click", () => { page--; renderTests(); });
$("next").addEventListener("click", () => { page++; renderTests(); });
const events = new EventSource("events");
events.addEventListener("refresh", event => {
  try {
    selected = JSON.parse(event.data).runId ?? undefined;
    page = 0;
    load();
  } catch (error) {
    fatal(`Invalid refresh event: ${error.message}`);
  }
});
events.addEventListener("error", () => {
  $("connection").textContent = "Live connection interrupted. Displayed evidence is retained; refresh or reopen this panel to reconnect.";
});
events.addEventListener("open", load);
window.addEventListener("pagehide", () => { events.close(); abort?.abort(); });
load();
