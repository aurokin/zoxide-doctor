// Eval corpus. Each case owns its own fake zoxide DB (a subset of fixture
// paths with hand-chosen frecency scores) so it fully controls the frecency
// landscape the candidate stage and backend see. Paths are fixture-relative
// (see fixture.ts); the runner resolves them against a temp fixture root.
//
// Every non-null `expected` is present in its own `db` — the candidate stage
// can only surface a directory that is in the DB (or in a local scan, which
// the offline harness does not exercise; see docs/evals.md). Where a case is
// deliberately hard, the per-case comment documents why.

export type EvalCategory =
  | "abbreviation"
  | "initialism"
  | "typo"
  | "ambiguous-siblings"
  | "monorepo-package"
  | "wrong-landing"
  | "stale-decoy"
  | "escalation"
  | "no-answer"
  | "multi-word";

export type DbEntry = { path: string; score: number };

export type EvalCase = {
  id: string;
  category: EvalCategory;
  description: string;
  query: string;
  db: DbEntry[];
  // A single fixture-relative path, or an accepted set of paths (any of which
  // counts as correct — used only for genuinely ambiguous cases), or null for
  // no-answer cases.
  expected: string | string[] | null;
  mode: "recovery" | "direct";
  wrongLanding?: string;
  rejectedPaths?: string[];
  beforePwd?: string;
};

export const CATEGORIES: EvalCategory[] = [
  "abbreviation",
  "initialism",
  "typo",
  "ambiguous-siblings",
  "monorepo-package",
  "wrong-landing",
  "stale-decoy",
  "escalation",
  "no-answer",
  "multi-word",
];

// Lexically-neutral filler repos. None of these match any case query, so they
// only ever contribute frecency bulk that makes recall@limit a real
// measurement. Kept disjoint from every case's specific/expected paths.
const NOISE_POOL: string[] = [
  "code/proj-alpha",
  "code/proj-beta",
  "code/proj-gamma",
  "code/widget-lib",
  "code/color-utils",
  "code/http-client",
  "code/json-schema",
  "code/date-fns-fork",
  "code/ml-experiments",
  "code/data-pipeline",
  "code/etl-jobs",
  "code/crypto-wallet",
  "code/game-engine",
  "code/shader-lab",
  "code/audio-tools",
  "code/video-encoder",
  "code/pdf-tools",
  "code/image-resize",
  "code/cron-runner",
  "code/queue-worker",
  "code/hono-api",
  "code/fastify-svc",
  "code/express-legacy",
  "code/nest-app",
  "code/remix-site",
  "code/next-dashboard",
  "code/vue-admin",
  "code/svelte-kit",
  "code/angular-old",
  "code/electron-shell",
  "code/tauri-app",
  "code/flutter-mobile",
  "code/rn-app",
  "code/go-services",
  "code/rust-cli",
  "code/python-scripts",
  "code/ruby-gem",
  "code/php-legacy",
  "code/java-batch",
  "code/kotlin-svc",
  "code/scala-etl",
  "code/elixir-chat",
  "code/haskell-lab",
  "code/zig-experiments",
  "code/c-embedded",
  "code/cpp-engine",
  "code/wasm-modules",
  "code/protobuf-defs",
  "code/openapi-specs",
  "code/grpc-gateway",
  "code/redis-cache",
  "code/postgres-tools",
  "code/mysql-migrate",
  "code/mongo-scripts",
  "code/kafka-consumer",
  "code/rabbitmq-worker",
  "code/nginx-configs",
  "code/docker-images",
  "code/helm-charts",
  "code/ansible-playbooks",
  "code/pulumi-stacks",
];

// Low-frecency filler entries drawn from the noise pool.
function noise(count: number, baseScore = 1): DbEntry[] {
  return NOISE_POOL.slice(0, count).map((path, index) => ({
    path,
    score: Math.round((baseScore + (count - index) * 0.05) * 1000) / 1000,
  }));
}

export const CASES: EvalCase[] = [
  // ============================ abbreviation ============================
  {
    id: "abbr-ascan",
    category: "abbreviation",
    description:
      "Canonical 'ascan' -> agentscan. Decoy ascan-archive is a substring match AND scores higher frecency, so the lexical top pick is the wrong (archive) directory.",
    query: "ascan",
    mode: "direct",
    expected: "code/agentscan",
    db: [
      { path: "code/ascan-archive", score: 9 },
      { path: "code/agentscan", score: 3 },
      { path: "code/scan-utils", score: 4 },
      { path: "code/scanner-rs", score: 2 },
      ...noise(12),
    ],
  },
  {
    id: "abbr-bkpr",
    category: "abbreviation",
    description: "'bkpr' -> bookkeeper via subsequence squeeze; backend is a weak 'b' decoy.",
    query: "bkpr",
    mode: "direct",
    expected: "code/bookkeeper",
    db: [
      { path: "code/bookkeeper", score: 5 },
      { path: "code/backend", score: 4 },
      { path: "code/blog", score: 2 },
      ...noise(10),
    ],
  },
  {
    id: "abbr-hh",
    category: "abbreviation",
    description: "'hh' -> harbor-hollow (double-initial squeeze).",
    query: "hh",
    mode: "direct",
    expected: "code/harbor-hollow",
    db: [
      { path: "code/harbor-hollow", score: 4 },
      { path: "code/http-client", score: 3 },
      ...noise(8),
    ],
  },
  {
    id: "abbr-dw",
    category: "abbreviation",
    description: "'dw' -> diffwarden; design-tokens is a 'd' decoy.",
    query: "dw",
    mode: "direct",
    expected: "code/diffwarden",
    db: [
      { path: "code/diffwarden", score: 4 },
      { path: "code/design-tokens", score: 3 },
      { path: "code/docs-site", score: 2 },
      ...noise(8),
    ],
  },
  {
    id: "abbr-papermario",
    category: "abbreviation",
    description:
      "HARD/adversarial: 'papermario' -> pm64-decomp requires knowing pm64 = Paper Mario 64. The directory name shares no lexical signal with the query, so it survives only on frecency. With a bulky DB it falls below the candidate limit -> a genuine recall failure the harness should surface.",
    query: "papermario",
    mode: "direct",
    expected: "emu/pm64-decomp",
    db: [{ path: "emu/pm64-decomp", score: 0.5 }, ...noise(55)],
  },

  // ============================= initialism =============================
  {
    id: "init-m64p",
    category: "initialism",
    description: "'m64p' -> mupen64plus-libretro-nx (number-embedded initialism).",
    query: "m64p",
    mode: "direct",
    expected: "code/mupen64plus-libretro-nx",
    db: [
      { path: "code/mupen64plus-libretro-nx", score: 5 },
      { path: "code/parallel-n64", score: 3 },
      { path: "code/n64-agent-evals", score: 2 },
      ...noise(8),
    ],
  },
  {
    id: "init-pn64",
    category: "initialism",
    description:
      "'pn64' -> parallel-n64. mupen64plus also subsequence-matches; parallel-n64 wins on frecency and shorter basename.",
    query: "pn64",
    mode: "direct",
    expected: "code/parallel-n64",
    db: [
      { path: "code/parallel-n64", score: 6 },
      { path: "code/mupen64plus-libretro-nx", score: 3 },
      { path: "code/n64-agent-evals", score: 2 },
      ...noise(8),
    ],
  },
  {
    id: "init-ds",
    category: "initialism",
    description:
      "HARD: 'ds' -> design-system. A 2-char query subsequence-matches many dirs (dotfiles, docs-site, design-tokens). Expected chosen by frecency + canonical package meaning; the lexical top pick is ambiguous.",
    query: "ds",
    mode: "direct",
    expected: "work/mega/packages/design-system",
    db: [
      { path: "work/mega/packages/design-system", score: 7 },
      { path: "code/dotfiles", score: 5 },
      { path: "code/design-tokens", score: 4 },
      { path: "code/docs-site", score: 3 },
      ...noise(8),
    ],
  },
  {
    id: "init-bw",
    category: "initialism",
    description: "'bw' -> billing-worker; plain billing lacks a 'w' so it is not a squeeze match.",
    query: "bw",
    mode: "direct",
    expected: "work/mega/packages/billing-worker",
    db: [
      { path: "work/mega/packages/billing-worker", score: 6 },
      { path: "work/mega/packages/billing", score: 4 },
      { path: "work/mega/packages/web", score: 2 },
      { path: "code/backend", score: 2 },
      ...noise(6),
    ],
  },
  {
    id: "init-gw",
    category: "initialism",
    description:
      "HARD: 'gw' -> gateway. graphql-gateway also matches g..w; expected chosen by frecency (the bare service).",
    query: "gw",
    mode: "direct",
    expected: "work/mega/services/gateway",
    db: [
      { path: "work/mega/services/gateway", score: 5 },
      { path: "code/graphql-gateway", score: 4 },
      { path: "code/go-services", score: 2 },
      ...noise(8),
    ],
  },

  // ================================ typo ================================
  {
    id: "typo-agentscna",
    category: "typo",
    description: "'agentscna' (transposed) -> agentscan via edit-distance similarity.",
    query: "agentscna",
    mode: "direct",
    expected: "code/agentscan",
    db: [
      { path: "code/agentscan", score: 5 },
      { path: "code/agent-sandbox", score: 3 },
      { path: "code/ascan-archive", score: 2 },
      ...noise(8),
    ],
  },
  {
    id: "typo-fontend",
    category: "typo",
    description: "'fontend' (missing r) -> frontend; front-desk is a shared-prefix decoy.",
    query: "fontend",
    mode: "direct",
    expected: "code/frontend",
    db: [
      { path: "code/frontend", score: 5 },
      { path: "code/front-desk", score: 3 },
      { path: "code/backend", score: 2 },
      ...noise(8),
    ],
  },
  {
    id: "typo-billng",
    category: "typo",
    description: "'billng' (missing i) -> billing; billing-worker is a longer decoy.",
    query: "billng",
    mode: "direct",
    expected: "work/mega/packages/billing",
    db: [
      { path: "work/mega/packages/billing", score: 6 },
      { path: "work/mega/packages/billing-worker", score: 4 },
      { path: "code/backend", score: 2 },
      ...noise(6),
    ],
  },
  {
    id: "typo-diffwardne",
    category: "typo",
    description: "'diffwardne' (transposed tail) -> diffwarden.",
    query: "diffwardne",
    mode: "direct",
    expected: "code/diffwarden",
    db: [
      { path: "code/diffwarden", score: 5 },
      { path: "code/design-tokens", score: 2 },
      ...noise(8),
    ],
  },
  {
    id: "typo-agnetscan",
    category: "typo",
    description: "'agnetscan' (transposed) -> agentscan; agent-sandbox shares the 'agent' prefix.",
    query: "agnetscan",
    mode: "direct",
    expected: "code/agentscan",
    db: [
      { path: "code/agentscan", score: 5 },
      { path: "code/agent-sandbox", score: 3 },
      { path: "code/my-agents", score: 2 },
      ...noise(8),
    ],
  },

  // ========================= ambiguous-siblings =========================
  {
    id: "ambig-api",
    category: "ambiguous-siblings",
    description:
      "'api' with code/api, work/api (both exact basename), api-legacy, apiv2. Two exact matches; tie broken by frecency -> code/api.",
    query: "api",
    mode: "direct",
    expected: "code/api",
    db: [
      { path: "code/api", score: 6 },
      { path: "work/api", score: 5 },
      { path: "code/api-legacy", score: 4 },
      { path: "code/apiv2", score: 3 },
      ...noise(6),
    ],
  },
  {
    id: "ambig-auth",
    category: "ambiguous-siblings",
    description: "'auth' -> auth (exact) over auth-ui/authz (substring).",
    query: "auth",
    mode: "direct",
    expected: "work/mega/packages/auth",
    db: [
      { path: "work/mega/packages/auth", score: 6 },
      { path: "work/mega/packages/auth-ui", score: 4 },
      { path: "work/mega/packages/authz", score: 3 },
      ...noise(6),
    ],
  },
  {
    id: "ambig-web",
    category: "ambiguous-siblings",
    description: "'web' -> web (exact) over web-legacy/webhooks.",
    query: "web",
    mode: "direct",
    expected: "work/mega/packages/web",
    db: [
      { path: "work/mega/packages/web", score: 6 },
      { path: "work/mega/packages/web-legacy", score: 4 },
      { path: "code/webhooks", score: 3 },
      ...noise(6),
    ],
  },
  {
    id: "ambig-blog",
    category: "ambiguous-siblings",
    description: "'blog' -> live blog over blog-2019-archive.",
    query: "blog",
    mode: "direct",
    expected: "code/blog",
    db: [
      { path: "code/blog", score: 6 },
      { path: "code/blog-2019-archive", score: 4 },
      ...noise(8),
    ],
  },
  {
    id: "ambig-ingest",
    category: "ambiguous-siblings",
    description: "'ingest' -> ingest (exact) over ingest-v2.",
    query: "ingest",
    mode: "direct",
    expected: "work/mega/services/ingest",
    db: [
      { path: "work/mega/services/ingest", score: 6 },
      { path: "work/mega/services/ingest-v2", score: 4 },
      ...noise(8),
    ],
  },

  // ========================= monorepo-package =========================
  {
    id: "mono-billing-worker",
    category: "monorepo-package",
    description: "'billing worker' (two words) -> billing-worker exact.",
    query: "billing worker",
    mode: "direct",
    expected: "work/mega/packages/billing-worker",
    db: [
      { path: "work/mega/packages/billing-worker", score: 5 },
      { path: "work/mega/packages/billing", score: 4 },
      { path: "work/mega/packages/billing-worker/src", score: 2 },
      ...noise(6),
    ],
  },
  {
    id: "mono-design-system",
    category: "monorepo-package",
    description: "'design system' -> design-system; design-tokens is a shared-prefix decoy.",
    query: "design system",
    mode: "direct",
    expected: "work/mega/packages/design-system",
    db: [
      { path: "work/mega/packages/design-system", score: 5 },
      { path: "work/mega/packages/design-system/src", score: 3 },
      { path: "code/design-tokens", score: 4 },
      ...noise(6),
    ],
  },
  {
    id: "mono-authz",
    category: "monorepo-package",
    description: "'authz' -> authz exact, not auth/auth-ui.",
    query: "authz",
    mode: "direct",
    expected: "work/mega/packages/authz",
    db: [
      { path: "work/mega/packages/authz", score: 5 },
      { path: "work/mega/packages/auth", score: 4 },
      { path: "work/mega/packages/auth-ui", score: 3 },
      ...noise(6),
    ],
  },
  {
    id: "mono-notifs",
    category: "monorepo-package",
    description: "'notifs' -> notifications (subsequence); notes is a decoy.",
    query: "notifs",
    mode: "direct",
    expected: "work/mega/services/notifications",
    db: [
      { path: "work/mega/services/notifications", score: 5 },
      { path: "code/notes", score: 3 },
      { path: "work/notes", score: 2 },
      ...noise(6),
    ],
  },
  {
    id: "mono-ingest-v2",
    category: "monorepo-package",
    description: "'ingest v2' -> ingest-v2 exact (contrast with ambig-ingest where the bare word wins).",
    query: "ingest v2",
    mode: "direct",
    expected: "work/mega/services/ingest-v2",
    db: [
      { path: "work/mega/services/ingest-v2", score: 5 },
      { path: "work/mega/services/ingest", score: 4 },
      ...noise(8),
    ],
  },

  // =========================== wrong-landing ===========================
  {
    id: "land-web",
    category: "wrong-landing",
    description:
      "Recovery: zoxide landed on web-legacy (matches 'web', high frecency). Expected is web. Model must not re-pick the marked wrong landing.",
    query: "web",
    mode: "recovery",
    wrongLanding: "work/mega/packages/web-legacy",
    expected: "work/mega/packages/web",
    db: [
      { path: "work/mega/packages/web-legacy", score: 9 },
      { path: "work/mega/packages/web", score: 5 },
      { path: "code/webhooks", score: 3 },
      ...noise(6),
    ],
  },
  {
    id: "land-auth",
    category: "wrong-landing",
    description:
      "Recovery: zoxide landed on the work/mega frecency magnet (no lexical match). Expected auth. Recall check: auth should still lead lexically despite mega's frecency.",
    query: "auth",
    mode: "recovery",
    wrongLanding: "work/mega",
    expected: "work/mega/packages/auth",
    db: [
      { path: "work/mega", score: 15 },
      { path: "work/mega/packages/auth", score: 5 },
      { path: "work/mega/packages/auth-ui", score: 3 },
      { path: "work/mega/packages/authz", score: 2 },
      ...noise(6),
    ],
  },
  {
    id: "land-api",
    category: "wrong-landing",
    description: "Recovery: landed on apiv2 (high frecency). Expected code/api (exact).",
    query: "api",
    mode: "recovery",
    wrongLanding: "code/apiv2",
    expected: "code/api",
    db: [
      { path: "code/apiv2", score: 9 },
      { path: "code/api", score: 5 },
      { path: "code/api-legacy", score: 3 },
      ...noise(6),
    ],
  },
  {
    id: "land-ds",
    category: "wrong-landing",
    description:
      "HARD recovery: landed on dotfiles, which is BOTH the frecency magnet AND a 'ds' subsequence match, so it is the lexical top pick and the wrong landing. Expected design-system.",
    query: "ds",
    mode: "recovery",
    wrongLanding: "code/dotfiles",
    expected: "work/mega/packages/design-system",
    db: [
      { path: "code/dotfiles", score: 12 },
      { path: "work/mega/packages/design-system", score: 5 },
      { path: "code/docs-site", score: 3 },
      ...noise(6),
    ],
  },
  {
    id: "land-ingest",
    category: "wrong-landing",
    description: "Recovery: landed on ingest-v2. Expected ingest (exact).",
    query: "ingest",
    mode: "recovery",
    wrongLanding: "work/mega/services/ingest-v2",
    expected: "work/mega/services/ingest",
    db: [
      { path: "work/mega/services/ingest-v2", score: 9 },
      { path: "work/mega/services/ingest", score: 5 },
      ...noise(8),
    ],
  },

  // ============================ stale-decoy ============================
  {
    id: "stale-agentscan",
    category: "stale-decoy",
    description:
      "Recovery: a backup copy of agentscan outscores the live repo on frecency (both exact basename). Expected the live code/agentscan.",
    query: "agentscan",
    mode: "recovery",
    wrongLanding: "code/dotfiles",
    expected: "code/agentscan",
    db: [
      { path: "backup/2024-01-code-old/agentscan", score: 12 },
      { path: "code/agentscan", score: 4 },
      { path: "code/dotfiles", score: 6 },
      ...noise(6),
    ],
  },
  {
    id: "stale-billing",
    category: "stale-decoy",
    description: "Recovery: backup billing copy outscores the live package. Expected the live billing.",
    query: "billing",
    mode: "recovery",
    wrongLanding: "code/dotfiles",
    expected: "work/mega/packages/billing",
    db: [
      { path: "backup/2024-01-code-old/billing", score: 12 },
      { path: "work/mega/packages/billing", score: 4 },
      { path: "work/mega/packages/billing-worker", score: 3 },
      { path: "code/dotfiles", score: 5 },
      ...noise(6),
    ],
  },
  {
    id: "stale-agentscan-triple",
    category: "stale-decoy",
    description:
      "Two stale copies (a nested backup and an -old sibling) both outscore the live agentscan on frecency. Expected the live repo.",
    query: "agentscan",
    mode: "direct",
    expected: "code/agentscan",
    db: [
      { path: "backup/2024-01-code-old/agentscan", score: 12 },
      { path: "backup/2023-agentscan-old", score: 8 },
      { path: "code/agentscan", score: 5 },
      ...noise(6),
    ],
  },
  {
    id: "stale-ascan-backup",
    category: "stale-decoy",
    description:
      "Abbreviation + staleness: 'ascan' with a high-frecency backup copy of agentscan as the decoy. Expected the live agentscan.",
    query: "ascan",
    mode: "direct",
    expected: "code/agentscan",
    db: [
      { path: "backup/2024-01-code-old/agentscan", score: 10 },
      { path: "code/agentscan", score: 4 },
      { path: "code/scan-utils", score: 2 },
      ...noise(6),
    ],
  },
  {
    id: "stale-billing-direct",
    category: "stale-decoy",
    description: "Direct 'billing' with a backup copy outscoring the live package. Expected the live billing.",
    query: "billing",
    mode: "direct",
    expected: "work/mega/packages/billing",
    db: [
      { path: "backup/2024-01-code-old/billing", score: 10 },
      { path: "work/mega/packages/billing", score: 4 },
      ...noise(8),
    ],
  },

  // ============================= escalation =============================
  {
    id: "esc-ascan",
    category: "escalation",
    description:
      "Recovery retry: first pick ascan-archive was rejected. With the archive excluded, agentscan is the intended target.",
    query: "ascan",
    mode: "recovery",
    wrongLanding: "code/dotfiles",
    rejectedPaths: ["code/ascan-archive"],
    expected: "code/agentscan",
    db: [
      { path: "code/dotfiles", score: 8 },
      { path: "code/ascan-archive", score: 9 },
      { path: "code/agentscan", score: 4 },
      { path: "code/scan-utils", score: 2 },
      ...noise(6),
    ],
  },
  {
    id: "esc-api",
    category: "escalation",
    description: "Recovery retry: code/api rejected; the next sibling is genuinely ambiguous between api-legacy and apiv2.",
    query: "api",
    mode: "recovery",
    wrongLanding: "code/dotfiles",
    rejectedPaths: ["code/api"],
    // Accepted set: with 'api' rejected, api-legacy and apiv2 are equally defensible siblings and every model picks apiv2 despite the frecency edge favoring api-legacy — the disambiguation is a coin flip, so both count.
    expected: ["code/api-legacy", "code/apiv2"],
    db: [
      { path: "code/dotfiles", score: 8 },
      { path: "code/api", score: 6 },
      { path: "code/api-legacy", score: 4 },
      { path: "code/apiv2", score: 3 },
      ...noise(6),
    ],
  },
  {
    id: "esc-auth",
    category: "escalation",
    description: "Recovery retry: auth rejected; the next sibling is genuinely ambiguous between auth-ui and authz.",
    query: "auth",
    mode: "recovery",
    wrongLanding: "code/dotfiles",
    rejectedPaths: ["work/mega/packages/auth"],
    // Accepted set: with 'auth' rejected, auth-ui and authz are equally plausible and every model picks authz despite the frecency edge favoring auth-ui — the disambiguation is a coin flip, so both count.
    expected: ["work/mega/packages/auth-ui", "work/mega/packages/authz"],
    db: [
      { path: "code/dotfiles", score: 8 },
      { path: "work/mega/packages/auth", score: 6 },
      { path: "work/mega/packages/auth-ui", score: 4 },
      { path: "work/mega/packages/authz", score: 3 },
      ...noise(6),
    ],
  },
  {
    id: "esc-ingest",
    category: "escalation",
    description: "Recovery retry: ingest-v2 rejected; expected the bare ingest.",
    query: "ingest",
    mode: "recovery",
    wrongLanding: "code/dotfiles",
    rejectedPaths: ["work/mega/services/ingest-v2"],
    expected: "work/mega/services/ingest",
    db: [
      { path: "code/dotfiles", score: 8 },
      { path: "work/mega/services/ingest-v2", score: 6 },
      { path: "work/mega/services/ingest", score: 4 },
      ...noise(8),
    ],
  },
  {
    id: "esc-web",
    category: "escalation",
    description: "Recovery retry: exact web rejected; expected web-legacy (higher frecency than webhooks).",
    query: "web",
    mode: "recovery",
    wrongLanding: "code/dotfiles",
    rejectedPaths: ["work/mega/packages/web"],
    expected: "work/mega/packages/web-legacy",
    db: [
      { path: "code/dotfiles", score: 8 },
      { path: "work/mega/packages/web", score: 6 },
      { path: "work/mega/packages/web-legacy", score: 4 },
      { path: "code/webhooks", score: 3 },
      ...noise(6),
    ],
  },

  // ============================== no-answer ==============================
  {
    id: "none-xyzzy",
    category: "no-answer",
    description: "'xyzzyplugh' matches nothing in the DB. Expected null.",
    query: "xyzzyplugh",
    mode: "direct",
    expected: null,
    db: [...noise(14)],
  },
  {
    id: "none-k8s",
    category: "no-answer",
    description: "'kubernetes-prod-eu' has no plausible target (no k8s dirs in this DB). Expected null.",
    query: "kubernetes-prod-eu",
    mode: "direct",
    expected: null,
    db: [
      { path: "code/backend", score: 5 },
      { path: "code/frontend", score: 4 },
      ...noise(10),
    ],
  },
  {
    id: "none-quux",
    category: "no-answer",
    description: "'quuxfrobnicate' is nonsense. Expected null.",
    query: "quuxfrobnicate",
    mode: "direct",
    expected: null,
    db: [...noise(12)],
  },
  {
    id: "none-payroll",
    category: "no-answer",
    description:
      "'payroll' with finance-adjacent decoys (payments-api, accounts-ui, ledger-core) present under a frecency magnet. None is payroll. Expected null -> tests false-positive resistance.",
    query: "payroll",
    mode: "recovery",
    wrongLanding: "code/dotfiles",
    expected: null,
    db: [
      { path: "code/dotfiles", score: 10 },
      { path: "code/payments-api", score: 4 },
      { path: "code/accounts-ui", score: 3 },
      { path: "code/ledger-core", score: 2 },
    ],
  },
  {
    id: "none-vpn",
    category: "no-answer",
    description: "'vpnconfig' has no target. Expected null.",
    query: "vpnconfig",
    mode: "direct",
    expected: null,
    db: [...noise(12)],
  },

  // ============================== multi-word ==============================
  {
    id: "multi-mega-web",
    category: "multi-word",
    description: "'mega web' -> work/mega/packages/web (path-component match across parents).",
    query: "mega web",
    mode: "direct",
    expected: "work/mega/packages/web",
    db: [
      { path: "work/mega/packages/web", score: 6 },
      { path: "work/mega/packages/web-legacy", score: 4 },
      { path: "work/mega", score: 3 },
      ...noise(6),
    ],
  },
  {
    id: "multi-ds-components",
    category: "multi-word",
    description: "'design system components' -> the deep design-system/src/components dir.",
    query: "design system components",
    mode: "direct",
    expected: "work/mega/packages/design-system/src/components",
    db: [
      { path: "work/mega/packages/design-system/src/components", score: 5 },
      { path: "work/mega/packages/design-system", score: 4 },
      { path: "work/mega/packages/design-system/src", score: 3 },
      { path: "work/mega/packages/design-system/src/tokens", score: 2 },
      ...noise(6),
    ],
  },
  {
    id: "multi-agentscan-core",
    category: "multi-word",
    description: "'agentscan core' -> the nested agentscan/packages/core dir, not the repo root.",
    query: "agentscan core",
    mode: "direct",
    expected: "code/agentscan/packages/core",
    db: [
      { path: "code/agentscan/packages/core", score: 5 },
      { path: "code/agentscan", score: 4 },
      { path: "code/agentscan/packages/cli", score: 2 },
      ...noise(6),
    ],
  },
  {
    id: "multi-billing-worker-src",
    category: "multi-word",
    description: "'billing worker src' -> the deep billing-worker/src dir.",
    query: "billing worker src",
    mode: "direct",
    expected: "work/mega/packages/billing-worker/src",
    db: [
      { path: "work/mega/packages/billing-worker/src", score: 5 },
      { path: "work/mega/packages/billing-worker", score: 4 },
      { path: "work/mega/packages/billing", score: 2 },
      ...noise(6),
    ],
  },
  {
    id: "multi-mega-gateway",
    category: "multi-word",
    description: "'mega gateway' -> work/mega/services/gateway; graphql-gateway is a decoy.",
    query: "mega gateway",
    mode: "direct",
    expected: "work/mega/services/gateway",
    db: [
      { path: "work/mega/services/gateway", score: 5 },
      { path: "code/graphql-gateway", score: 3 },
      { path: "work/mega", score: 2 },
      ...noise(6),
    ],
  },
];
