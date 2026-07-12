import type { BackendSummary, LiveReport, RecallReport } from "./runner.js";

// Human-readable renderers for stdout. Kept separate from the runner so the
// runner stays pure data and the CLI script stays lean.

export function formatRecallReport(report: RecallReport): string {
  const lines: string[] = [];
  lines.push(`# zdr recall eval (offline, limit=${report.limit})`);
  lines.push("");
  lines.push(
    `Overall: recall ${pct(report.overall.recall)} (${report.overall.found}/${report.overall.total}) ` +
      `| mean rank ${fmtNum(report.overall.meanRank)} ` +
      `| lexical-would-win ${pct(report.overall.lexicalWinRate)} (${report.overall.lexicalWins}/${report.overall.total})`,
  );
  lines.push(`Null-expected cases (recall-exempt): ${report.nullCases.length}`);
  lines.push("");

  lines.push("## Per-category");
  lines.push(
    table(
      ["category", "n", "recall", "found", "mean-rank", "lexwin"],
      report.perCategory.map((entry) => [
        entry.category,
        String(entry.total),
        pct(entry.recall),
        `${entry.found}/${entry.total}`,
        fmtNum(entry.meanRank),
        `${entry.lexicalWins}/${entry.total}`,
      ]),
    ),
  );
  lines.push("");

  lines.push("## Cases");
  lines.push(
    table(
      ["id", "category", "query", "found", "rank", "cands", "lexwin"],
      report.cases.map((result) => [
        result.id,
        result.category,
        result.query,
        result.found ? "yes" : "NO",
        result.rank === null ? "-" : String(result.rank),
        String(result.candidateCount),
        result.topLexicalIsExpected ? "yes" : "no",
      ]),
    ),
  );
  lines.push("");

  lines.push("## Null-expected (reported separately, recall-exempt)");
  lines.push(
    table(
      ["id", "category", "query", "cands"],
      report.nullCases.map((result) => [result.id, result.category, result.query, String(result.candidateCount)]),
    ),
  );
  lines.push("");

  lines.push("## Recall misses (expected not in candidate list)");
  if (report.misses.length === 0) {
    lines.push("(none)");
  } else {
    for (const miss of report.misses) {
      lines.push(`- ${miss.id} [${miss.category}] query='${miss.query}' expected=${miss.expectedPath}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function formatLiveReport(report: LiveReport): string {
  const lines: string[] = [];
  lines.push("# zdr live eval");
  lines.push("");
  for (const summary of report.summaries) {
    lines.push(...formatBackendSummary(summary));
    lines.push("");
  }
  return lines.join("\n");
}

function formatBackendSummary(summary: BackendSummary): string[] {
  const lines: string[] = [];
  lines.push(`## ${summary.backendId}`);
  lines.push(
    `accuracy ${pct(summary.accuracy)} (${summary.correct}/${summary.runs}) ` +
      `| errors ${summary.errorCount} ` +
      `| null-precision ${fmtRatio(summary.nullPrecision)} ` +
      `| null-recall ${fmtRatio(summary.nullRecall)} ` +
      `| latency p50 ${fmtNum(summary.latencyP50)}ms p95 ${fmtNum(summary.latencyP95)}ms`,
  );
  lines.push(
    table(
      ["category", "n", "accuracy", "correct"],
      summary.perCategory.map((entry) => [
        entry.category,
        String(entry.total),
        pct(entry.accuracy),
        `${entry.correct}/${entry.total}`,
      ]),
    ),
  );
  lines.push("misses:");
  if (summary.misses.length === 0) {
    lines.push("  (none)");
  } else {
    for (const miss of summary.misses) {
      lines.push(`  ${miss.caseId} query='${miss.query}' expected=${miss.expectedPath ?? "null"} picked=${miss.pickedPath ?? "null"}`);
    }
  }
  if (summary.errors.length > 0) {
    lines.push("errors:");
    for (const errored of summary.errors) {
      lines.push(`  ${errored.caseId} query='${errored.query}' error=${errored.error}`);
    }
  }
  return lines;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const render = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [render(headers), separator, ...rows.map(render)].join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtRatio(value: number | null): string {
  return value === null ? "n/a" : pct(value);
}

function fmtNum(value: number | null): string {
  return value === null ? "-" : String(value);
}
