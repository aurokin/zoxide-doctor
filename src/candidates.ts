import { basename } from "node:path";
import type { FinishedZState } from "./shell-state.js";
import type { ZoxideEntry } from "./zoxide.js";

export type Candidate = {
  id: string;
  path: string;
  display_path: string;
  zoxide_rank: number;
  zoxide_score: number;
  lexical_score: number;
  total_score: number;
  reasons: string[];
  wrong_landing_candidate: boolean;
};

export function buildCandidates(input: {
  state: FinishedZState;
  entries: ZoxideEntry[];
  limit?: number;
}): Candidate[] {
  const query = input.state.query_argv.join(" ").trim();
  const scored = input.entries.map((entry) => scoreEntry(query, entry, input.state.after_pwd));
  scored.sort((a, b) => {
    if (b.total_score !== a.total_score) {
      return b.total_score - a.total_score;
    }
    return a.zoxide_rank - b.zoxide_rank;
  });

  const limit = input.limit ?? 50;
  const selected = new Map<string, Candidate>();
  for (const candidate of scored.slice(0, limit)) {
    selected.set(candidate.path, candidate);
  }

  const landed = scored.find((candidate) => candidate.path === input.state.after_pwd);
  if (landed) {
    selected.set(landed.path, landed);
  }

  return Array.from(selected.values())
    .sort((a, b) => {
      if (b.total_score !== a.total_score) {
        return b.total_score - a.total_score;
      }
      return a.zoxide_rank - b.zoxide_rank;
    })
    .map((candidate, index) => ({
      ...candidate,
      id: `c${String(index + 1).padStart(3, "0")}`,
    }));
}

function scoreEntry(query: string, entry: ZoxideEntry, landedPath: string): Candidate {
  const normalizedQuery = normalize(query);
  const components = pathComponents(entry.path);
  const base = normalize(basename(entry.path));
  const full = normalize(components.join(" "));
  const compactFull = normalize(components.join(""));
  const acronym = components.map((component) => normalize(component).at(0) ?? "").join("");
  const reasons: string[] = [];
  let lexicalScore = 0;

  if (normalizedQuery.length > 0) {
    if (base === normalizedQuery) {
      lexicalScore += 100;
      reasons.push("basename exact");
    }
    if (base.includes(normalizedQuery)) {
      lexicalScore += 70;
      reasons.push("basename contains query");
    }
    if (compactFull.includes(normalizedQuery)) {
      lexicalScore += 55;
      reasons.push("path components contain query");
    }
    if (isSubsequence(normalizedQuery, base)) {
      lexicalScore += 45;
      reasons.push("basename subsequence");
    } else if (isSubsequence(normalizedQuery, compactFull)) {
      lexicalScore += 35;
      reasons.push("path subsequence");
    }
    if (acronym.includes(normalizedQuery) || normalizedQuery.includes(acronym)) {
      lexicalScore += 35;
      reasons.push("acronym match");
    }
    const editScore = similarity(normalizedQuery, base);
    if (editScore >= 0.55) {
      lexicalScore += Math.round(editScore * 35);
      reasons.push("basename similarity");
    }
    if (full.includes(normalizedQuery)) {
      lexicalScore += 20;
      reasons.push("path text contains query");
    }
  }

  const frecencyScore = Math.max(0, 25 - Math.log2(entry.rank + 1) * 4);
  const wrongLanding = entry.path === landedPath;
  if (wrongLanding) {
    reasons.push("zoxide landed here");
  }

  return {
    id: "",
    path: entry.path,
    display_path: redactHome(entry.path),
    zoxide_rank: entry.rank,
    zoxide_score: entry.score,
    lexical_score: lexicalScore,
    total_score: lexicalScore + frecencyScore,
    reasons,
    wrong_landing_candidate: wrongLanding,
  };
}

function pathComponents(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) {
    return false;
  }
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) {
      index += 1;
      if (index === needle.length) {
        return true;
      }
    }
  }
  return false;
}

function similarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (previous[j] ?? Number.POSITIVE_INFINITY) + 1;
      const insertion = (current[j - 1] ?? Number.POSITIVE_INFINITY) + 1;
      const substitution = (previous[j - 1] ?? Number.POSITIVE_INFINITY) + cost;
      current[j] = Math.min(deletion, insertion, substitution);
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j] ?? Number.POSITIVE_INFINITY;
    }
  }

  return previous[b.length] ?? 0;
}

function redactHome(path: string): string {
  const home = process.env.HOME;
  if (home && path === home) {
    return "~";
  }
  if (home && path.startsWith(`${home}/`)) {
    return `~/${path.slice(home.length + 1)}`;
  }
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}
