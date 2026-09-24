import { XMLParser, XMLValidator } from "fast-xml-parser";
import { MAX_TESTS, ReportError, checkTotal, countTests, issue, numeric, object, optionalString } from "./model.js";
import type { Issue, ParsedReport, Status, Suite, TestCase } from "./model.js";

interface Element {
  tag: string;
  attrs: Record<string, unknown>;
  children: Element[];
  text: string;
}

function elements(value: unknown, depth = 0): Element[] {
  if (depth > 64) throw new ReportError("unsafe_xml", "XML nesting exceeds 64 levels.");
  if (!Array.isArray(value)) throw new ReportError("malformed_xml", "Unexpected XML structure.");
  return value.map(item => {
    const record = object(item, "XML element");
    const tag = Object.keys(record).find(key => key !== ":@") ?? "";
    if (tag === "#text" || tag === "#cdata") {
      return { tag: "#text", attrs: {}, children: [], text: String(record[tag] ?? "") };
    }
    const children = elements(record[tag], depth + 1);
    return {
      tag,
      attrs: record[":@"] === undefined ? {} : object(record[":@"], "XML attributes"),
      children,
      text: "",
    };
  });
}

function numberAttr(node: Element, key: string, integer = false): number | null {
  const value = node.attrs[key];
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    throw new ReportError("invalid_report", `JUnit ${key} must be a nonnegative number.`);
  }
  return numeric(Number(value), `JUnit ${key}`, integer);
}

function time(node: Element): number | null {
  const seconds = numberAttr(node, "time");
  if (seconds === null) return null;
  const ms = seconds * 1000;
  if (!Number.isFinite(ms)) throw new ReportError("invalid_report", "JUnit time is too large.");
  return ms;
}

function detail(node: Element): string {
  const leaves: string[] = [];
  const pending = [node];
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    if (next.tag === "#text") leaves.push(next.text);
    else for (let index = next.children.length - 1; index >= 0; index--) {
      const child = next.children[index];
      if (child) pending.push(child);
    }
  }
  return [optionalString(node.attrs.type), optionalString(node.attrs.message), leaves.join("")]
    .filter((value): value is string => Boolean(value)).join("\n") || `${node.tag} (no details supplied)`;
}

function guardXml(text: string): void {
  const markup = text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(markup) || /<\?(?!xml(?:\s|\?>))/i.test(markup)) {
    throw new ReportError("unsafe_xml", "DTDs, entity declarations, and processing instructions are not accepted.");
  }
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)[\w:.-]+;/.test(markup)) {
    throw new ReportError("malformed_xml", "Undeclared XML entities are not accepted.");
  }
  for (const match of markup.matchAll(/&#(x[0-9a-fA-F]+|\d+);/g)) {
    const encoded = match[1] ?? "";
    const code = encoded.startsWith("x") ? Number.parseInt(encoded.slice(1), 16) : Number(encoded);
    if (![9, 10, 13].includes(code) && !(code >= 32 && code <= 0xd7ff) &&
        !(code >= 0xe000 && code <= 0xfffd) && !(code >= 0x10000 && code <= 0x10ffff)) {
      throw new ReportError("malformed_xml", "XML contains an invalid character reference.");
    }
  }
  let depth = 0;
  let tags = 0;
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[\w:.-]+(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  for (const [token] of text.matchAll(tokens)) {
    if (token.startsWith("<!") || token.startsWith("<?")) continue;
    tags++;
    if (token.startsWith("</")) depth--;
    else if (!token.endsWith("/>")) depth++;
    if (depth > 64 || tags > 500_000) throw new ReportError("unsafe_xml", "XML exceeds nesting or element limits.");
  }
}

export function parseJUnit(text: string): ParsedReport {
  guardXml(text);
  const validation = XMLValidator.validate(text);
  if (validation !== true) throw new ReportError("malformed_xml", `Invalid XML at line ${validation.err.line}; no results were inferred.`);
  const parser = new XMLParser({
    preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "",
    parseTagValue: false, parseAttributeValue: false, trimValues: false,
    ignoreDeclaration: true, htmlEntities: false, maxNestedTags: 64,
    processEntities: { enabled: true, maxTotalExpansions: 100_000, maxExpandedLength: 16 * 1024 * 1024 },
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(text);
  } catch {
    throw new ReportError("malformed_xml", "XML parser rejected the report (invalid structure or resource limit).");
  }
  const roots = elements(parsed).filter(node => node.tag !== "#text");
  const root = roots[0];
  if (roots.length !== 1 || !root || !["testsuites", "testsuite"].includes(root.tag)) {
    throw new ReportError("unsupported_format", "JUnit requires a single testsuite or testsuites root.");
  }
  const issues: Issue[] = [];
  const suites: Suite[] = [];
  const totals: Record<string, number> = {};
  let testCount = 0;

  function test(node: Element, suite: Suite, index: number): TestCase {
    const pointer = `${suite.source}/testcase[${index}]`;
    const name = optionalString(node.attrs.name);
    if (name === null) throw new ReportError("invalid_report", "JUnit testcase is missing its name.");
    const outcomes = node.children.filter(child => ["failure", "error", "skipped"].includes(child.tag));
    const kinds = new Set(outcomes.map(outcome => outcome.tag));
    const attrStatus = optionalString(node.attrs.status);
    let status: Status = kinds.has("error") ? "error" : kinds.has("failure") ? "failed" : kinds.has("skipped") ? "skipped" : "passed";
    if (kinds.size > 1) issues.push(issue("contradictory_status", "JUnit testcase has incompatible outcome elements.", pointer));
    if (outcomes.length === 0 && attrStatus) {
      const statuses: Record<string, Status> = {
        passed: "passed", run: "passed", success: "passed", completed: "passed",
        failed: "failed", failure: "failed", error: "error",
        skipped: "skipped", notrun: "skipped", disabled: "skipped", todo: "todo",
      };
      status = (Object.hasOwn(statuses, attrStatus) ? statuses[attrStatus] : undefined) ?? "unknown";
      if (status === "unknown") issues.push(issue("unknown_status", "JUnit testcase has an unsupported status attribute.", pointer));
    }
    if (outcomes.length > 0 && attrStatus === "passed" && status !== "passed") {
      issues.push(issue("contradictory_status", "JUnit testcase claims passed but has a non-passing outcome element.", pointer));
    }
    const allowed = ["#text", "failure", "error", "skipped", "system-out", "system-err", "properties"];
    if (node.children.some(child => !allowed.includes(child.tag))) {
      issues.push(issue("unsupported_junit_element", "Testcase contains an unsupported result element; inspect the raw report.", pointer));
    }
    const classname = optionalString(node.attrs.classname);
    testCount++;
    if (testCount > MAX_TESTS) throw new ReportError("report_too_large", `Reports are limited to ${MAX_TESTS} tests.`);
    return {
      id: `${suite.id}:${index}`, name, fullName: [classname, name].filter(Boolean).join(" > "),
      ancestors: classname ? [classname] : [], status,
      rawStatus: outcomes.length > 0 ? outcomes.map(outcome => outcome.tag).join("+") : attrStatus,
      durationMs: time(node), messages: outcomes.map(detail),
      source: {
        pointer, file: optionalString(node.attrs.file),
        line: numberAttr(node, "line", true), column: numberAttr(node, "column", true),
      },
    };
  }

  function walk(node: Element, parentId: string | null, source: string): TestCase[] {
    const id = String(suites.length);
    let suite: Suite | null = null;
    if (node.tag === "testsuite" || node.children.some(child => child.tag === "testcase")) {
      if (suites.length >= MAX_TESTS) throw new ReportError("report_too_large", "Too many JUnit suites.");
      suite = {
        id, name: optionalString(node.attrs.name) ?? (node.tag === "testsuites" ? "(ungrouped tests)" : "(unnamed suite)"), parentId,
        rawStatus: optionalString(node.attrs.status), durationMs: time(node),
        tests: [], errors: [], source,
      };
      suites.push(suite);
    }
    const descendants: TestCase[] = [];
    let childSuite = 0;
    for (const child of node.children) {
      if (child.tag === "testcase" && suite) {
        const result = test(child, suite, suite.tests.length);
        suite.tests.push(result);
        descendants.push(result);
      } else if (["testsuite", "testsuites"].includes(child.tag)) {
        descendants.push(...walk(child, suite?.id ?? parentId, `${source}/${child.tag}[${childSuite++}]`));
      } else if (["error", "failure"].includes(child.tag)) {
        if (suite) suite.errors.push(detail(child));
        else {
          suites.push({
            id: `root-error-${suites.length}`, name: "(report error)", parentId: null, rawStatus: child.tag,
            durationMs: null, tests: [], errors: [detail(child)], source,
          });
        }
      } else if (!["#text", "properties", "system-out", "system-err"].includes(child.tag) &&
          !issues.some(item => item.code === "unsupported_junit_element" && item.source === source)) {
        issues.push(issue("unsupported_junit_element", "Suite contains an unsupported element; inspect the raw report.", source));
      }
    }
    const counts = countTests(descendants);
    for (const [key, actual] of Object.entries({
      tests: counts.total, failures: counts.failed, errors: counts.error, skipped: counts.skipped + counts.todo,
      disabled: descendants.filter(row => row.rawStatus === "disabled").length,
    })) checkTotal(totals, key, numberAttr(node, key, true), actual, issues, source);
    return descendants;
  }
  const tests = walk(root, null, `/${root.tag}`);
  return {
    format: "junit", suites, counts: countTests(tests),
    suiteErrors: suites.reduce((sum, suite) => sum + suite.errors.length, 0),
    issues, startedAt: optionalString(root.attrs.timestamp), durationMs: time(root),
    interrupted: false, reportedSuccess: null, reportedTotals: totals,
  };
}
