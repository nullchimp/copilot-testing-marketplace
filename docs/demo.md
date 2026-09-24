# Test Lab setup and demo

## Client and installation

Use an authenticated Copilot client supporting legacy plugins, SDK extensions and native canvases. The tested combination is macOS app **1.1.23**, CLI **1.0.87-0**, and the SDK bundled with that app. No compatibility with every IDE/terminal is implied.

After the marketplace tree is published to its default branch:

```sh
copilot plugin marketplace add nullchimp/copilot-testing-marketplace
copilot plugin marketplace browse testing-marketplace
copilot plugin install test-lab@testing-marketplace
```

The catalog contains exactly **one** plugin. Installation supplies the `test-lab` skill, Test Engineer (`test-lab:test-lab-engineer` in this CLI), `test-lab-context7`, and the plugin-owned `test-dashboard`. Restart/reload the session so components are available. A developer can instead add a local marketplace checkout with `copilot plugin marketplace add /path/to/checkout`; this does not require a second extension installation.

The legacy manifest's `extensions` path is the **container** `./extensions`, not `./extensions/test-dashboard`. The runtime scans its immediate children for `extension.mjs`. The extension imports the host SDK and ships its own bundled report code and renderer; installing it needs no `npm install`. Do not add an Agent Plugins 1.0 `$schema`, use `exclusive: true`, or suppress built-ins.

## A real report-driven run

Work in an approved isolated repository/worktree with its dependencies already available. A backend-only project is sufficient; neither remote integration is required.

Prompt:

> Use the test-lab skill to run this repository's existing unit test command once. Respect its instructions and scope, publish its actual reporter evidence, and open the native dashboard. Do not install dependencies or start services.

The skill should inspect scripts/configuration/version/package manager, choose the requested existing command, prepare fresh artifact paths, and invoke that command with compatible one-shot reporter options through the host's normal shell permissions. If materially different commands remain plausible, it asks before choosing. It never interprets an echo/placeholder script as tests.

Observe a **separate import tool call even after a nonzero exit**. A failing test command must not skip report ingestion. Then observe `open_canvas` using the returned stable handle, and `select_run` when needed. Search by suite/test/failure text, filter a status, expand failure details, order by duration, and select a prior run. No per-test live progress or flaky-test claims are fabricated.

For a negative demonstration, use an existing approved failing test, or explicitly request a disposable test-only regression in an isolated worktree. Do not weaken assertions, bless snapshots, copy private fixtures into this public plugin, or publish raw reports/logs.

### Tool/API contract

The same helpers implement extension tools and canvas actions:

| Tool | Purpose |
| --- | --- |
| `test_lab_prepare_run` | Reserve a run and private reporter/coverage paths. Does not execute anything. |
| `test_lab_import_report` | Import the actual report and observed exit/completion, retaining invalid-report records and nonzero exits. |
| `test_lab_read_run` | Read history, summary and a bounded failure preview; return the full normalized artifact path and native open handle. |

Preparation takes `format: "jest" | "vitest" | "junit"`, the intended base `command`, and optional `workingDirectory`, `runnerName`, and `runnerVersion`. Import takes its `runId`, `exitCode` (number or `null`), and `completion: "completed" | "interrupted" | "unknown"`. Supply `executedCommand` for the actual invocation with reporter flags, excluding secrets. The default source is the prepared report path; an explicit `reportPath` must remain inside the active worktree or SDK workspace.

For an already-recorded run, supply `evidenceStartedAt` from **observed execution metadata**, not a guessed date. Copy only that known run's evidence into the prepared paths; keep any original-source chain in private session notes. Otherwise freshness checks reject older reports. Do not touch timestamps just to bypass them.

Optional `coveragePath` must equal the returned run-specific `coverage-summary.json` path. Coverage is Istanbul JSON summary only; stale repository coverage, absent metrics, malformed summaries and empty denominators remain explicit. No auto-installation of coverage providers.

Canvas actions are `prepare_run`, `import_report`, `read_run`, `select_run` and `view_status`. Their inputs follow the same schemas as the matching tools. `view_status` reports iframe acknowledgements: compare `lastRender.runId` to the published run. This is stronger than an open RPC, but **not independent visual proof**.

On the tested runtime, `extensions.reload` clears open-panel bookkeeping. The data is retained: reopen the same returned native handle after reload. For resume/new panels, use the same worktree scope; storage is not keyed by the panel's transient ID. If canvas support or the SDK workspace is unavailable, state it rather than opening a substitute or claiming a rendered result.

The standalone, already-bundled library at `plugins/test-lab/extensions/test-dashboard/lib/test-lab.mjs` exports `ReportStore`, `normalizeReport`, and `parseCoverage` for integration validation. `ReportStore.create({ cwd, workspacePath })` requires the actual SDK workspace path; `prepare`, `importReport`, and `read` use the contracts above. Do not hardcode a Copilot home.

### Normalized evidence

Schema version **1** includes run/worktree identity, command, format and optional runner metadata, preparation/import/observed-start timestamps, completion and nullable exit code, source path/hash/byte count, parsed suites/tests, derived counts, issues and optional coverage provenance. Types live in `src/model.ts`; persisted input is validated before use.

Counts are derived from test rows. Suite/collection errors are separate, not fictitious tests. Missing values are `null`, not invented zeros. Duplicate names have positional source IDs. Report totals are checked when comparable. Vitest logical suite totals include describe blocks and are deliberately not equated with its file rows; pending Vitest assertions remain unknown/incomplete rather than being treated like Jest skips.

One JSON/XML file per run is supported. Use an existing aggregate reporter for shards/multiple files, or clearly identify the imported subset and leave whole-command completion unknown. Flat root testcases (including Node's JUnit producer) are retained in a source-backed ungrouped container. XML nesting is limited to 64, input to 16 MiB, tests to 50,000, and normalized expansion to 24 MiB. DTDs, custom entity declarations, external resources and processing instructions are rejected. Tool issue previews are capped at 50 and UI note/error previews at 100; the complete normalized artifact retains every detail. The iframe has no shell/run endpoint; report strings are rendered as text.

## Context7

The plugin's only shared MCP definition is `test-lab-context7`, using HTTP at `https://mcp.context7.com/mcp` and only `resolve-library-id` / `query-docs`.

Use public library/version/generic questions, such as how the installed Playwright Test version supports role locators or `toHaveText`. Do not include private source, application names, logs, paths, IDs or credentials. Anonymous access has low limits; optional authentication belongs in supported client-private configuration following [current provider instructions](https://context7.com/docs/resources/all-clients), never this repository. Do not assume environment interpolation or overwrite another connection. A rate limit or failed lookup is an explicit documentation gap, not a reason to block local reports.

## Private Azure Playwright Workspaces connection

Use an **existing preview-enabled workspace** and approved remotely reachable demo/test URL. No resource provisioning, application deployment, tunnels, browser installation or policy changes are part of this plugin. A remote browser cannot reach your laptop's localhost merely because the client can.

The documented endpoint shape is:

```text
https://<region>.mcp.playwright.microsoft.com/playwrightworkspaces/<workspace-id>/mcp
```

The public [connection example](../plugins/test-lab/config/playwright-workspace.example.json) is inert documentation, not a loadable MCP config. Never commit a completed copy.

**Authentication is a client prerequisite, not a plugin capability.** The service advertises Entra authentication and keyless service-level access is possible. Use a supported private host OAuth/Entra flow when your client provides it; verify its actual tool connection. Service metadata or a separately authenticated protocol call does not prove native Copilot has completed sign-in. Do not paste a short-lived bearer token into a static config, read credential files, or ask for tokens in chat.

Microsoft also documents this Copilot CLI alternative, **only if access-token authentication is already permitted by the user's workspace policy**:

1. Enter `/mcp add`, use `test-lab-playwright` (or retain the user's existing name), and choose **HTTP**.
2. Enter the workspace's real endpoint privately. Add the `x-api-key` header with the authorized token **inside the client's private configuration UI**, not a prompt or committed file.
3. Choose **Auto** deferred tools and finish the connection. Check the real tool catalog and authentication state without printing credential-bearing config.

Do not enable local/key auth to make this alternative work. Do not promise an undocumented OAuth flow or undocumented environment substitution. Credential storage/encryption is client-specific; do not assume a saved header uses an OS secret store. Where the client lacks a permitted authentication mechanism, browser exploration remains blocked while the dashboard still works.

The agent's default allowlist names `test-lab-playwright` explicitly and grants only session lifecycle, text observation and focused interaction methods. It excludes screenshots/images, file upload, arbitrary evaluation/code execution and broad server wildcards. If an existing connection has another name, leave it intact and use the client's supported local agent-profile override to replace only the server prefix with the **actual discovered name**, keeping the explicit method list. Confirm the selected profile's live tool catalog; do not invent aliases or create duplicate connections.

Sources: [Microsoft CLI quickstart](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/quickstart-automate-browser-tasks-remote-mcp), [service lifecycle and tool reference](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/how-to-playwright-workspaces-remote-mcp).

## Browser exploration and requested regression tests

Select Test Engineer and supply an approved reachable URL and expected behavior:

> Explore the specified read-only flow at my approved test URL. Use public version-appropriate Context7 guidance and the private hosted Playwright tools. Observe before acting, verify the resulting state, and close the browser session. Do not edit files.

The agent creates one browser session, privately retains `browserSessionId`, navigates to the explicit URL, takes accessibility snapshots/find results, performs focused serial actions, and verifies state. It re-observes before retrying a timed-out non-idempotent action. Dialog outcomes are handled rather than blindly replayed. Expired/disconnected sessions are not silently reused.

**Always inspect a successful `close_browser_session` result**, including on error paths. A prose claim is not cleanup evidence; unresolved cleanup must be reported. Browser sessions may incur Azure charges. Keep session IDs/live-view links private and use synthetic data, not destructive production actions.

Only a subsequent explicit request authorizes test authoring:

> Add focused regression tests for the agreed behavior, including a useful negative/boundary case, using the repository's existing setup. Run the smallest relevant selection with test-lab and open its real report. Do not change production code, dependencies, CI or configuration.

If E2E tooling is absent, the agent reports the prerequisite and labels requested drafts **unrun**. Hosted browser clicks are never converted into fake JUnit assertions. A valid failing test that reveals a production bug stays failing until a separately authorized fix.

## Verification boundaries

The repository includes original deterministic adapter fixtures, actual Playwright Test JUnit producer output, persistence/path/input/error tests, SDK type checks, isolated marketplace/plugin lifecycle checks, and real-browser DOM checks. `npm run fixture:playwright` deliberately produces 2 passed, 1 failed and 2 skipped cases without a browser, then sanitizes machine-specific paths and volatile timing.

Native report opening must be checked independently from HTTP/RPC success. Remote Context7/Azure protocol smoke tests establish service access, not a particular native client's authentication or an application-specific regression run. A live hosted-browser demo is not complete until the selected native agent can access the private tools, use an approved target, obtain public documentation, run any requested tests and verify browser cleanup.

If an MCP server offers a **native MCP App**, preserve its original interactive result separately. Automatically open/focus it only through a supported native-result action. When the client exposes no such action, say so plainly: a website, Browser canvas, Markdown table or this dashboard is not an equivalent replacement.
