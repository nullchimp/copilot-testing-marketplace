# Testing marketplace

One Copilot marketplace, **`testing-marketplace`**, with one plugin, **`test-lab`**: a native test dashboard, a repository-aware test-running skill, **Test Engineer**, and shared hosted Context7. The agent can also use your privately configured hosted Azure Playwright Workspaces connection.

Test counts come only from **Jest JSON, Vitest JSON, or JUnit XML** reports. Playwright Test uses its existing JUnit reporter, not a fourth adapter. Browser observations and documentation lookups never inflate test counts.

## Install

Once the plugin is published on the repository's selected ref:

```sh
copilot plugin marketplace add nullchimp/copilot-testing-marketplace
copilot plugin install test-lab@testing-marketplace
```

Restart the session or use the client's plugin reload action. Invoke the **test-lab** skill to run your repository's existing command and automatically open/focus its dashboard. Select **Test Engineer** to explore behavior and design regression coverage; it writes tests **only when requested**. Its profile file ID is `test-lab-engineer`; this runtime namespaces the installed selection ID as `test-lab:test-lab-engineer`.

No consumer `npm install`, local MCP server, Azure provisioning, automatic dependency installation, watch mode, or service startup is needed. Executing tests still requires the repository's existing test environment.

## What the dashboard shows

Run identity, actual command/exit status, runner metadata, derived pass/fail/skip/todo/error counts, suite/collection errors, searchable/filterable tests, failure details, reported durations, slow tests, optional same-run Istanbul coverage, and prior-run selection.

Missing, empty, malformed, interrupted, unsupported, contradictory, and all-skipped reports cannot appear as an all-green success. Missing duration/coverage is not zero. Raw statuses, duplicate parameterized names and source hashes are preserved. Evidence stays under the **SDK session workspace**, keyed by repository/worktree/run; it survives new panels, reload and session resume, never living in the plugin cache.

## Remote integrations

**Context7** is the only active bundled MCP server: `test-lab-context7` at `https://mcp.context7.com/mcp`, restricted to `resolve-library-id` and `query-docs`. Anonymous access has low rate limits. Use supported client-private authentication and the [provider's current documentation](https://context7.com/docs/resources/all-clients) for optional higher limits; never commit keys or send private code/logs/paths.

**Azure Playwright Workspaces (preview)** is an optional, private prerequisite named `test-lab-playwright`. The public plugin does not register a placeholder endpoint or store credentials. Its [sanitized example](plugins/test-lab/config/playwright-workspace.example.json) is intentionally **not** an active MCP configuration. Entra service authentication is possible; native-client sign-in and tool availability must be checked separately. The documented `x-api-key` alternative must not be used to weaken workspace policy. Remote browsers need an approved reachable URL, may incur charges, and must always be closed. Laptop localhost is not reachable by assumption.

See [the setup, demo, compatibility and troubleshooting guide](docs/demo.md).

## Compatibility and development

This is a **legacy Copilot plugin manifest**, without an Agent Plugins 1.0 `$schema`; that format gives `extensions` a different meaning. On CLI **1.0.87-0**, `extensions: ["./extensions"]` names a **container** whose immediate child contains `extension.mjs`. Do not replace it with the individual canvas folder. No built-in extensions are suppressed.

The native canvas APIs are experimental. Development validation targets GitHub Copilot for macOS **1.1.23**, its installed SDK, and CLI **1.0.87-0**. A plain terminal or another Copilot client may support the skill/reports but lack the side-panel renderer. RPC success is not visual proof; DOM/browser checks and native panel acknowledgements are separate.

For contributors (Node.js 20.18+):

```sh
npm ci --ignore-scripts
npm run check
npm run test:ui
npm run check:sdk -- "$COPILOT_SDK_PATH"
npm run check:runtime -- "$COPILOT_SDK_PATH"
```

UI checks use an already-installed Chrome, or `TEST_LAB_BROWSER_EXECUTABLE`; they do not download browsers. Runtime checks require a working authenticated Copilot CLI and an explicit installed SDK path. They use disposable Copilot settings/cache, exercise installation, agent tools, native canvas routing, reload/resume and plugin toggles, and never edit the user's MCP configuration. No model inference or subagents are involved.

`npm run build` reproducibly bundles the maintained XML parser into the committed distributable with [license notices](plugins/test-lab/THIRD_PARTY_NOTICES.txt). The SDK remains host-provided. `npm run fixture:playwright` regenerates the original browser-free Playwright producer fixture with intentionally mixed outcomes; paths/timing are sanitized and those fixtures are never dashboard showcase data.
