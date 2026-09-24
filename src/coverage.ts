import { ReportError, numeric, object, unavailableCoverage } from "./model.js";
import type { Coverage, Provenance } from "./model.js";

export function parseCoverage(text: string, source: Provenance): Coverage {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ReportError("invalid_coverage", "Coverage summary is not valid JSON.");
  }
  const total = object(object(input, "coverage summary").total, "coverage total");
  const result = unavailableCoverage();
  result.source = source;
  result.reason = null;
  let found = false;
  for (const key of ["lines", "branches", "functions", "statements"] as const) {
    if (total[key] === undefined) continue;
    const metric = object(total[key], `coverage ${key}`);
    const all = numeric(metric.total, `${key}.total`, true);
    const covered = numeric(metric.covered, `${key}.covered`, true);
    const skipped = numeric(metric.skipped, `${key}.skipped`, true);
    const pct = metric.pct === "Unknown" ? null : numeric(metric.pct, `${key}.pct`);
    if (all === null || covered === null || covered > all || (skipped !== null && skipped > all) || (pct !== null && pct > 100)) {
      throw new ReportError("invalid_coverage", `Coverage ${key} has invalid totals.`);
    }
    const percent = all === 0 ? null : covered * 100 / all;
    if (percent !== null && pct !== null && Math.abs(percent - pct) > 0.011) {
      throw new ReportError("invalid_coverage", `Coverage ${key} percentage contradicts its totals.`);
    }
    result.metrics[key] = { total: all, covered, skipped, percent, reportedPercent: pct };
    found = true;
  }
  if (!found) throw new ReportError("invalid_coverage", "No supported Istanbul summary metrics were found.");
  result.status = "available";
  return result;
}
