import { mkdir } from "node:fs/promises";
import { join, normalize } from "node:path";

// A declarative, adversarial model of a realistic developer machine home
// directory. Every path is relative to a caller-provided fixture root that
// stands in for `~`. Directories only — no stray files — because candidate
// scoring and recall only ever look at directory paths.
//
// The design goal is traps: decoys that outrank the intended directory on
// substring, frecency, or both, so the eval corpus can measure whether the
// candidate stage surfaces the right directory and whether a backend can pick
// it out of the noise.

export const FIXTURE_DIRS: string[] = [
  // ~/code — the primary project pile. Includes the canonical abbreviation
  // trap (agentscan vs ascan-archive), initialism-rich emulator forks,
  // ambiguous siblings (api/api-legacy/apiv2, frontend/front-desk), and the
  // dotfiles frecency magnet.
  "code/agentscan",
  "code/agentscan/packages",
  "code/agentscan/packages/core",
  "code/agentscan/packages/core/src",
  "code/agentscan/packages/cli",
  "code/agent-sandbox",
  "code/my-agents",
  "code/ascan-archive",
  "code/scan-utils",
  "code/scanner-rs",
  "code/zoxide-doctor",
  "code/diffwarden",
  "code/dotfiles",
  "code/tprompt",
  "code/harbor-hollow",
  "code/api",
  "code/api-legacy",
  "code/apiv2",
  "code/frontend",
  "code/front-desk",
  "code/backend",
  "code/bookkeeper",
  "code/blog",
  "code/blog-2019-archive",
  "code/mupen64plus-libretro-nx",
  "code/parallel-n64",
  "code/n64-agent-evals",
  "code/notes",
  "code/playground",
  "code/sandbox",
  "code/cli-tools",
  "code/webhooks",
  "code/infra",
  "code/terraform-modules",
  "code/telemetry-lib",
  "code/graphql-gateway",
  "code/mobile-app",
  "code/desktop-app",
  "code/marketing-site",
  "code/docs-site",
  "code/design-tokens",
  "code/scratch",

  // ~/work/mega — a package/service monorepo. Tests package-name jumps
  // (bw -> billing-worker, ds -> design-system) and deep-path multi-word
  // queries (design system components). work/mega is the high-frecency
  // wrong-landing magnet.
  "work",
  "work/api",
  "work/scripts",
  "work/docs",
  "work/notes",
  "work/mega",
  "work/mega/packages",
  "work/mega/packages/auth",
  "work/mega/packages/auth-ui",
  "work/mega/packages/authz",
  "work/mega/packages/billing",
  "work/mega/packages/billing-worker",
  "work/mega/packages/billing-worker/src",
  "work/mega/packages/design-system",
  "work/mega/packages/design-system/src",
  "work/mega/packages/design-system/src/components",
  "work/mega/packages/design-system/src/tokens",
  "work/mega/packages/web",
  "work/mega/packages/web/src",
  "work/mega/packages/web-legacy",
  "work/mega/services",
  "work/mega/services/ingest",
  "work/mega/services/ingest-v2",
  "work/mega/services/gateway",
  "work/mega/services/notifications",

  // ~/emu — emulator/decomp projects with number-heavy, initialism-heavy
  // names. pm64-decomp is the semantic-alias trap: "papermario" has no
  // lexical overlap with the directory name at all.
  "emu",
  "emu/pm64-decomp",
  "emu/mupen-builds",
  "emu/roms",

  // Hidden / config dirs — realism noise.
  ".config",
  ".config/nvim",
  ".config/zdr",
  ".config/git",
  ".local",
  ".local/share",
  ".local/state",
  ".cache",

  // Non-code noise plus a stale backup tree holding old copies of live repos.
  "Documents",
  "Documents/taxes-2025",
  "Documents/resume",
  "Downloads",
  "Downloads/installers",
  "Pictures",
  "Pictures/screenshots",
  "Pictures/wallpapers",
  "Music",
  "Videos",
  "Desktop",
  "school",
  "school/cs4400-databases",
  "school/cs3500-oop",
  "backup",
  "backup/2024-01-code-old",
  "backup/2024-01-code-old/agentscan",
  "backup/2024-01-code-old/billing",
  "backup/2023-agentscan-old",

  // Generic filler repos. These give the fake zoxide DB enough realistic bulk
  // that recall@limit is a meaningful measurement rather than a formality, and
  // serve as the lexically-neutral noise pool referenced by cases.ts.
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
  "code/k8s-manifests",
  "code/helm-charts",
  "code/ansible-playbooks",
  "code/pulumi-stacks",
  "code/cdk-app",
  "code/serverless-fns",
  "code/lambda-handlers",
  "code/edge-workers",
  "code/cron-jobs",
  "code/batch-processor",
  "code/report-gen",
  "code/invoice-svc",
  "code/payments-api",
  "code/ledger-core",
  "code/accounts-ui",
  "code/crm-backend",
  "code/erp-modules",
  "code/hr-portal",
  "code/support-desk",
  "code/ticketing-app",
  "code/wiki-engine",
  "code/forum-app",
  "code/chat-widget",
  "code/legacy-monolith",
];

// Directories that represent git repositories. Not used by candidate scoring
// (which is path-lexical only) but modeled for realism and available to
// consumers that want to reason about repo roots.
export const FIXTURE_REPOS: ReadonlySet<string> = new Set([
  "code/agentscan",
  "code/agent-sandbox",
  "code/my-agents",
  "code/ascan-archive",
  "code/scan-utils",
  "code/scanner-rs",
  "code/zoxide-doctor",
  "code/diffwarden",
  "code/dotfiles",
  "code/tprompt",
  "code/harbor-hollow",
  "code/api",
  "code/api-legacy",
  "code/apiv2",
  "code/frontend",
  "code/front-desk",
  "code/backend",
  "code/bookkeeper",
  "code/blog",
  "code/mupen64plus-libretro-nx",
  "code/parallel-n64",
  "code/n64-agent-evals",
  "work/mega",
  "work/mega/packages/auth",
  "work/mega/packages/auth-ui",
  "work/mega/packages/authz",
  "work/mega/packages/billing",
  "work/mega/packages/billing-worker",
  "work/mega/packages/design-system",
  "work/mega/packages/web",
  "work/mega/packages/web-legacy",
  "work/mega/services/ingest",
  "work/mega/services/ingest-v2",
  "work/mega/services/gateway",
  "work/mega/services/notifications",
  "emu/pm64-decomp",
]);

export const FIXTURE_DIR_SET: ReadonlySet<string> = new Set(FIXTURE_DIRS);

export type MaterializedFixture = {
  root: string;
  dirs: string[];
  byRelative: Record<string, string>;
};

// Resolve a fixture-relative path (with optional leading "~/", "~", or "/")
// against a fixture root that stands in for the home directory.
export function resolveFixturePath(root: string, relative: string): string {
  let rel = relative.trim();
  if (rel === "~" || rel === "") {
    return normalizeDir(root);
  }
  if (rel.startsWith("~/")) {
    rel = rel.slice(2);
  } else if (rel.startsWith("/")) {
    rel = rel.slice(1);
  }
  return normalizeDir(join(root, rel));
}

// Create every fixture directory under `root` and return absolute paths.
export async function materializeFixture(root: string): Promise<MaterializedFixture> {
  const absoluteRoot = normalizeDir(root);
  const byRelative: Record<string, string> = {};
  const dirs: string[] = [];
  await mkdir(absoluteRoot, { recursive: true });
  for (const relative of FIXTURE_DIRS) {
    const absolute = resolveFixturePath(absoluteRoot, relative);
    await mkdir(absolute, { recursive: true });
    byRelative[relative] = absolute;
    dirs.push(absolute);
  }
  return { root: absoluteRoot, dirs, byRelative };
}

function normalizeDir(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
}
