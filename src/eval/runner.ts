import { buildCandidates, type Candidate } from "../candidates.js";
import { DEFAULT_CONFIG, type ZdrConfig } from "../config.js";
import type { ProviderReasoning, SelectionResult } from "../provider/select.js";
import type { FinishedZState } from "../shell-state.js";
import type { ZoxideEntry } from "../zoxide.js";
import { CATEGORIES, type EvalCase, type EvalCategory } from "./cases.js";
import { resolveFixturePath } from "./fixture.js";

// Mirror of the backend contract in src/provider/backends.ts (built in
// parallel). We only reference the types here; the live factory below lazily
// imports the real module so offline runs and tests never touch it.
export type BackendKind = "pi" | "claude";
export type BackendTierSpec = { backend: BackendKind; name?: string; model: string };
export type BackendSelectionInput = {
  state: FinishedZState;
  candidates: Candidate[];
  rejectedPaths?: string[];
  privacy?: ZdrConfig["privacy"];
  reasoning?: ProviderReasoning;
};

// The narrow interface the live runner drives. Tests provide fakes; the real
// backend is wrapped by createLiveBackend.
export type EvalBackend = {
  id: string;
  select(input: BackendSelectionInput): Promise<SelectionResult>;
};

const CANDIDATE_LIMIT = 50;

export type PreparedCase = {
  case: EvalCase;
  state: FinishedZState;
  candidates: Candidate[];
  input: BackendSelectionInput;
  expectedPath: string | null;
  wrongLandingPath: string | null;
  rejectedPaths: string[];
};

// Turn a corpus case into a BackendSelectionInput using the real production
// candidate builder, so recall measures exactly what a backend would see.
export function prepareCase(
  evalCase: EvalCase,
  fixtureRoot: string,
  options: { reasoning?: ProviderReasoning } = {},
): PreparedCase {
  const resolve = (relative: string) => resolveFixturePath(fixtureRoot, relative);
  const beforePwd = resolve(evalCase.beforePwd ?? "code");
  const wrongLandingPath = evalCase.wrongLanding ? resolve(evalCase.wrongLanding) : null;
  const afterPwd = evalCase.mode === "recovery" ? wrongLandingPath ?? resolve("code/dotfiles") : beforePwd;
  const rejectedPaths = (evalCase.rejectedPaths ?? []).map(resolve);

  const state: FinishedZState = {
    schema_version: 1,
    status: "finished",
    attempt_id: `eval-${evalCase.id}`,
    query_argv: evalCase.query.split(/\s+/).filter((token) => token.length > 0),
    before_pwd: beforePwd,
    after_pwd: afterPwd,
    exit_status: 0,
    shell: "zsh",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:01.000Z",
  };

  const entries = toEntries(evalCase.db.map((entry) => ({ path: resolve(entry.path), score: entry.score })));
  const candidates = buildCandidates({
    state,
    entries,
    limit: CANDIDATE_LIMIT,
    rejectedPaths,
  });

  const reasoning = evalCase.category === "escalation" ? "high" : options.reasoning;
  const input: BackendSelectionInput = {
    state,
    candidates,
    privacy: DEFAULT_CONFIG.privacy,
    ...(rejectedPaths.length > 0 ? { rejectedPaths } : {}),
    ...(reasoning ? { reasoning } : {}),
  };

  return {
    case: evalCase,
    state,
    candidates,
    input,
    expectedPath: evalCase.expected ? resolve(evalCase.expected) : null,
    wrongLandingPath,
    rejectedPaths,
  };
}

// zoxide lists entries in descending score order; rank follows that order.
function toEntries(scored: { path: string; score: number }[]): ZoxideEntry[] {
  return [...scored]
    .sort((a, b) => b.score - a.score)
    .map((entry, index) => ({ path: entry.path, score: entry.score, rank: index + 1 }));
}

// ================================ recall ================================

export type RecallCaseResult = {
  id: string;
  category: EvalCategory;
  query: string;
  expectedPath: string;
  found: boolean;
  rank: number | null;
  candidateCount: number;
  topLexicalPath: string | null;
  topLexicalIsExpected: boolean;
};

export type NullCaseResult = {
  id: string;
  category: EvalCategory;
  query: string;
  candidateCount: number;
};

export type CategoryRecall = {
  category: EvalCategory;
  total: number;
  found: number;
  recall: number;
  meanRank: number | null;
  lexicalWins: number;
};

export type RecallReport = {
  limit: number;
  cases: RecallCaseResult[];
  nullCases: NullCaseResult[];
  overall: {
    total: number;
    found: number;
    recall: number;
    meanRank: number | null;
    lexicalWins: number;
    lexicalWinRate: number;
  };
  perCategory: CategoryRecall[];
  misses: RecallCaseResult[];
};

export function scoreRecallCase(prepared: PreparedCase): RecallCaseResult | NullCaseResult {
  if (prepared.expectedPath === null) {
    return {
      id: prepared.case.id,
      category: prepared.case.category,
      query: prepared.case.query,
      candidateCount: prepared.candidates.length,
    };
  }
  const index = prepared.candidates.findIndex((candidate) => candidate.path === prepared.expectedPath);
  const topLexical = topLexicalCandidate(prepared.candidates);
  return {
    id: prepared.case.id,
    category: prepared.case.category,
    query: prepared.case.query,
    expectedPath: prepared.expectedPath,
    found: index !== -1,
    rank: index === -1 ? null : index + 1,
    candidateCount: prepared.candidates.length,
    topLexicalPath: topLexical?.path ?? null,
    topLexicalIsExpected: topLexical?.path === prepared.expectedPath,
  };
}

// The candidate a naive local heuristic would pick: highest lexical score,
// ties broken by the existing (frecency) order.
function topLexicalCandidate(candidates: Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (best === null || candidate.lexical_score > best.lexical_score) {
      best = candidate;
    }
  }
  return best;
}

export function runRecall(cases: EvalCase[], fixtureRoot: string): RecallReport {
  const caseResults: RecallCaseResult[] = [];
  const nullCases: NullCaseResult[] = [];
  for (const evalCase of cases) {
    const result = scoreRecallCase(prepareCase(evalCase, fixtureRoot));
    if ("expectedPath" in result) {
      caseResults.push(result);
    } else {
      nullCases.push(result);
    }
  }

  const perCategory = CATEGORIES.map((category) => summarizeCategory(category, caseResults)).filter(
    (entry) => entry.total > 0,
  );
  const found = caseResults.filter((result) => result.found);
  const lexicalWins = caseResults.filter((result) => result.topLexicalIsExpected).length;
  const foundRanks = found.map((result) => result.rank ?? 0);

  return {
    limit: CANDIDATE_LIMIT,
    cases: caseResults,
    nullCases,
    overall: {
      total: caseResults.length,
      found: found.length,
      recall: ratio(found.length, caseResults.length),
      meanRank: mean(foundRanks),
      lexicalWins,
      lexicalWinRate: ratio(lexicalWins, caseResults.length),
    },
    perCategory,
    misses: caseResults.filter((result) => !result.found),
  };
}

function summarizeCategory(category: EvalCategory, results: RecallCaseResult[]): CategoryRecall {
  const inCategory = results.filter((result) => result.category === category);
  const found = inCategory.filter((result) => result.found);
  return {
    category,
    total: inCategory.length,
    found: found.length,
    recall: ratio(found.length, inCategory.length),
    meanRank: mean(found.map((result) => result.rank ?? 0)),
    lexicalWins: inCategory.filter((result) => result.topLexicalIsExpected).length,
  };
}

// ================================= live =================================

export type LiveRunRecord = {
  backendId: string;
  caseId: string;
  category: EvalCategory;
  query: string;
  repeat: number;
  expectedPath: string | null;
  pickedPath: string | null;
  correct: boolean;
  isNullExpected: boolean;
  predictedNull: boolean;
  latencyMs: number;
  confidence: number | null;
  usage: unknown;
  error: string | null;
};

export type BackendSummary = {
  backendId: string;
  runs: number;
  correct: number;
  accuracy: number;
  errorCount: number;
  perCategory: { category: EvalCategory; total: number; correct: number; accuracy: number }[];
  nullPrecision: number | null;
  nullRecall: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  misses: LiveRunRecord[];
  errors: LiveRunRecord[];
};

export type LiveReport = {
  records: LiveRunRecord[];
  summaries: BackendSummary[];
};

export type LiveRunOptions = {
  repeat?: number;
  timeoutMs?: number;
  concurrency?: number;
  reasoning?: ProviderReasoning;
  onRecord?: (record: LiveRunRecord) => void;
};

const DEFAULT_TIMEOUT_MS = 60_000;

export async function runLive(
  backends: EvalBackend[],
  cases: EvalCase[],
  fixtureRoot: string,
  options: LiveRunOptions = {},
): Promise<LiveReport> {
  const repeat = options.repeat ?? 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const prepareOptions = options.reasoning ? { reasoning: options.reasoning } : {};
  const prepared = cases.map((evalCase) => prepareCase(evalCase, fixtureRoot, prepareOptions));
  const records: LiveRunRecord[] = [];

  // Backends run sequentially; within a backend, up to `concurrency` calls run
  // at once (default 1 = fully sequential).
  for (const backend of backends) {
    const tasks: { item: PreparedCase; iteration: number }[] = [];
    for (const item of prepared) {
      for (let iteration = 1; iteration <= repeat; iteration += 1) {
        tasks.push({ item, iteration });
      }
    }
    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < tasks.length) {
        const task = tasks[cursor];
        cursor += 1;
        if (!task) {
          return;
        }
        const record = await runOne(backend, task.item, task.iteration, timeoutMs);
        records.push(record);
        options.onRecord?.(record);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  }

  return { records, summaries: backends.map((backend) => summarizeBackend(backend.id, records)) };
}

async function runOne(
  backend: EvalBackend,
  prepared: PreparedCase,
  iteration: number,
  timeoutMs: number,
): Promise<LiveRunRecord> {
  const expectedPath = prepared.expectedPath;
  const isNullExpected = expectedPath === null;
  const start = performance.now();
  const base = {
    backendId: backend.id,
    caseId: prepared.case.id,
    category: prepared.case.category,
    query: prepared.case.query,
    repeat: iteration,
    expectedPath,
    isNullExpected,
  };
  try {
    const result = await withTimeout(backend.select(prepared.input), timeoutMs);
    const pickedPath = result.candidate?.path ?? null;
    const predictedNull = pickedPath === null;
    return {
      ...base,
      pickedPath,
      predictedNull,
      correct: pickedPath === expectedPath,
      latencyMs: roundMs(performance.now() - start),
      confidence: typeof result.selection.confidence === "number" ? result.selection.confidence : null,
      usage: result.usage ?? null,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      pickedPath: null,
      predictedNull: false,
      correct: false,
      latencyMs: roundMs(performance.now() - start),
      confidence: null,
      usage: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function summarizeBackend(backendId: string, allRecords: LiveRunRecord[]): BackendSummary {
  const records = allRecords.filter((record) => record.backendId === backendId);
  const correct = records.filter((record) => record.correct);
  const errors = records.filter((record) => record.error !== null);
  const predictedNulls = records.filter((record) => record.predictedNull);
  const expectedNulls = records.filter((record) => record.isNullExpected);
  const correctNulls = predictedNulls.filter((record) => record.isNullExpected);
  const latencies = records.filter((record) => record.error === null).map((record) => record.latencyMs);

  const perCategory = CATEGORIES.map((category) => {
    const inCategory = records.filter((record) => record.category === category);
    const correctInCategory = inCategory.filter((record) => record.correct);
    return {
      category,
      total: inCategory.length,
      correct: correctInCategory.length,
      accuracy: ratio(correctInCategory.length, inCategory.length),
    };
  }).filter((entry) => entry.total > 0);

  return {
    backendId,
    runs: records.length,
    correct: correct.length,
    accuracy: ratio(correct.length, records.length),
    errorCount: errors.length,
    perCategory,
    nullPrecision: predictedNulls.length === 0 ? null : ratio(correctNulls.length, predictedNulls.length),
    nullRecall: expectedNulls.length === 0 ? null : ratio(correctNulls.length, expectedNulls.length),
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
    misses: records.filter((record) => !record.correct && record.error === null),
    errors,
  };
}

// ============================= live backend =============================

export type BackendSpec = {
  id: string;
  tier: BackendTierSpec;
};

// Parse "pi:<provider>:<model>" or "claude:<model>".
export function parseBackendSpec(raw: string): BackendSpec {
  const parts = raw.split(":");
  if (parts[0] === "pi") {
    const [, name, model] = parts;
    if (!name || !model) {
      throw new Error(`invalid pi backend spec '${raw}'; expected pi:<provider>:<model>`);
    }
    return { id: raw, tier: { backend: "pi", name, model } };
  }
  if (parts[0] === "claude") {
    const model = parts.slice(1).join(":");
    if (!model) {
      throw new Error(`invalid claude backend spec '${raw}'; expected claude:<model>`);
    }
    return { id: raw, tier: { backend: "claude", model } };
  }
  throw new Error(`unknown backend kind in '${raw}'; expected 'pi:' or 'claude:'`);
}

// Thin factory wrapping the real selectWithBackend. Imported lazily so the
// module is only loaded for live runs.
export function createLiveBackend(spec: BackendSpec): EvalBackend {
  return {
    id: spec.id,
    async select(input) {
      const { selectWithBackend } = await import("../provider/backends.js");
      return selectWithBackend(spec.tier, input);
    },
  };
}

// ================================ helpers ================================

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend call timed out after ${timeoutMs}ms`)), timeoutMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 1000) / 1000;
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 100) / 100;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * percentileValue) - 1;
  return roundMs(sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0);
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}
