# Evaluation harness

The eval suite measures how well zdr recovers a bad `z` jump over a realistic,
adversarial fake developer filesystem. It answers three separate questions that
the old single-query benchmark could not:

1. **Candidate recall** — does the intended directory even make the candidate
   list a backend sees? (offline, no network)
2. **Model accuracy** — does a given backend pick it out of that list? (live)
3. **Latency / consistency** — how fast and how stable is each backend? (live)

Everything lives under `src/eval/**` with a single runner at
`scripts/run-evals.ts`. The corpus and fake filesystem are intentionally
data-heavy; the runner itself is small.

## Layout

- `src/eval/fixture.ts` — a declarative model of a developer home directory
  (~180 dirs) plus `materializeFixture(root)` that mkdirs the tree under a
  caller-provided temp root. Designed adversarially: decoys that outrank the
  intended directory on substring, frecency, or both.
- `src/eval/cases.ts` — the corpus (45 answerable cases + 5 null cases). Each
  case owns its own fake zoxide DB (a subset of fixture paths with hand-chosen
  frecency scores) so it fully controls the frecency landscape.
- `src/eval/runner.ts` — `prepareCase` (builds the real production candidate
  list via `buildCandidates`), the offline recall scorer, and the live runner.
- `src/eval/format.ts` — human-readable table renderers.
- `scripts/run-evals.ts` — the CLI entry point.

## Running

### Recall mode (offline, default)

Zero network, fast, CI-safe. This is what the tests assert on.

```
bun scripts/run-evals.ts
bun scripts/run-evals.ts --category stale-decoy
bun scripts/run-evals.ts --cases abbr-ascan,land-ds
bun scripts/run-evals.ts --jsonl recall.jsonl
```

For every case with a non-null `expected`, recall mode reports whether the
expected path is in the candidate list and at what rank, plus whether the top
lexical candidate already equals the expected path (`lexwin` — "would a dumb
local heuristic have won without the model?"). Null-expected cases are
recall-exempt and reported separately.

### Live mode (`--live`)

Makes real provider calls, so it refuses to run unless `ZDR_EVAL_LIVE=1` is set.

```
ZDR_EVAL_LIVE=1 bun scripts/run-evals.ts --live \
  --backend pi:openai-codex:gpt-5.3-codex-spark \
  --backend claude:haiku \
  --repeat 3 --reasoning high --jsonl live.jsonl
```

Flags:

- `--backend <spec>` — repeatable. See the spec format below.
- `--repeat N` — runs each case N times (default 1) to measure consistency.
- `--cases <id,id,...>` / `--category <cat>` — filter the corpus.
- `--reasoning <minimal|low|medium|high|xhigh>` — reasoning level for
  non-escalation cases. Escalation cases always use `high` (they model the 2nd
  zdr call) and pass their rejected paths in the prompt.
- `--concurrency N` — cap concurrent calls within a backend (default 1,
  sequential). Backends themselves always run sequentially.
- `--jsonl <path>` — write full per-run records (one JSON object per line).

For each (case × backend × repeat) the runner records the picked path (or
null), whether it was correct, latency, usage, and any error. A 60s per-call
timeout guard prevents one hang from killing the run; timeouts and thrown
errors are counted as **errors**, tracked separately from wrong picks. The
stdout report gives, per backend: overall and per-category accuracy,
null-precision (of predicted nulls, how many were expected-null) and
null-recall, latency p50/p95, an error count, and a "misses" section listing
each wrong case (id, query, expected vs picked).

## Backend spec format

- `pi:<provider>:<model>` — e.g. `pi:openai-codex:gpt-5.3-codex-spark`
- `claude:<model>` — e.g. `claude:haiku`

Specs are parsed into the `BackendTierSpec` shape consumed by
`src/provider/backends.ts` (`selectWithBackend`), which the live runner imports
lazily. Offline recall mode and all tests use fake backends and never touch
that module.

## Categories

| Category | What it stresses |
|----------|------------------|
| `abbreviation` | Non-substring squeezes: `ascan` -> agentscan, `bkpr` -> bookkeeper. |
| `initialism` | Initial/number squeezes: `m64p`, `pn64`, `ds`, `bw`, `gw`. |
| `typo` | Edit-distance recovery: `agentscna`, `fontend`, `billng`. |
| `ambiguous-siblings` | Same query, several plausible siblings (`api`/`api-legacy`/`apiv2`); expected chosen by frecency, documented per case. |
| `monorepo-package` | Package-name jumps inside `work/mega` (`billing worker`, `ingest v2`). |
| `wrong-landing` | Recovery where the DB's top-frecency dir is the wrong landing; the model must not re-pick it. |
| `stale-decoy` | A backup copy (`backup/2024-01-code-old/agentscan`) outscores the live repo on frecency; expected the live one. |
| `escalation` | 2nd zdr call: `rejectedPaths` holds the wrong first pick; expected the second-best interpretation. |
| `no-answer` | Queries with no reasonable target; expected `null`. |
| `multi-word` | Multi-token and deep-path queries (`design system components`). |

## Current recall-mode output

Regenerate with `bun scripts/run-evals.ts`. Home paths shown as `~`.

```
# zdr recall eval (offline, limit=50)

Overall: recall 97.8% (44/45) | mean rank 1.2 | lexical-would-win 77.8% (35/45)
Null-expected cases (recall-exempt): 5

## Per-category
category            n  recall  found  mean-rank  lexwin
------------------  -  ------  -----  ---------  ------
abbreviation        5  80.0%   4/5    1.25       3/5
initialism          5  100.0%  5/5    1          5/5
typo                5  100.0%  5/5    1          5/5
ambiguous-siblings  5  100.0%  5/5    1          5/5
monorepo-package    5  100.0%  5/5    1          5/5
wrong-landing       5  100.0%  5/5    1.2        4/5
stale-decoy         5  100.0%  5/5    2          0/5
escalation          5  100.0%  5/5    1.4        3/5
multi-word          5  100.0%  5/5    1          5/5

## Cases
id                        category            query                     found  rank  cands  lexwin
------------------------  ------------------  ------------------------  -----  ----  -----  ------
abbr-ascan                abbreviation        ascan                     yes    2     16     no
abbr-bkpr                 abbreviation        bkpr                      yes    1     13     yes
abbr-hh                   abbreviation        hh                        yes    1     9      yes
abbr-dw                   abbreviation        dw                        yes    1     11     yes
abbr-papermario           abbreviation        papermario                NO     -     50     no
init-m64p                 initialism          m64p                      yes    1     11     yes
init-pn64                 initialism          pn64                      yes    1     11     yes
init-ds                   initialism          ds                        yes    1     12     yes
init-bw                   initialism          bw                        yes    1     10     yes
init-gw                   initialism          gw                        yes    1     11     yes
typo-agentscna            typo                agentscna                 yes    1     11     yes
typo-fontend              typo                fontend                   yes    1     11     yes
typo-billng               typo                billng                    yes    1     9      yes
typo-diffwardne           typo                diffwardne                yes    1     10     yes
typo-agnetscan            typo                agnetscan                 yes    1     11     yes
ambig-api                 ambiguous-siblings  api                       yes    1     10     yes
ambig-auth                ambiguous-siblings  auth                      yes    1     9      yes
ambig-web                 ambiguous-siblings  web                       yes    1     9      yes
ambig-blog                ambiguous-siblings  blog                      yes    1     10     yes
ambig-ingest              ambiguous-siblings  ingest                    yes    1     10     yes
mono-billing-worker       monorepo-package    billing worker            yes    1     9      yes
mono-design-system        monorepo-package    design system             yes    1     9      yes
mono-authz                monorepo-package    authz                     yes    1     9      yes
mono-notifs               monorepo-package    notifs                    yes    1     9      yes
mono-ingest-v2            monorepo-package    ingest v2                 yes    1     10     yes
land-web                  wrong-landing       web                       yes    1     9      yes
land-auth                 wrong-landing       auth                      yes    1     10     yes
land-api                  wrong-landing       api                       yes    1     9      yes
land-ds                   wrong-landing       ds                        yes    2     9      no
land-ingest               wrong-landing       ingest                    yes    1     10     yes
stale-agentscan           stale-decoy         agentscan                 yes    2     9      no
stale-billing             stale-decoy         billing                   yes    2     10     no
stale-agentscan-triple    stale-decoy         agentscan                 yes    2     9      no
stale-ascan-backup        stale-decoy         ascan                     yes    2     9      no
stale-billing-direct      stale-decoy         billing                   yes    2     10     no
esc-ascan                 escalation          ascan                     yes    1     9      yes
esc-api                   escalation          api                       yes    2     9      no
esc-auth                  escalation          auth                      yes    2     9      no
esc-ingest                escalation          ingest                    yes    1     10     yes
esc-web                   escalation          web                       yes    1     9      yes
multi-mega-web            multi-word          mega web                  yes    1     9      yes
multi-ds-components       multi-word          design system components  yes    1     10     yes
multi-agentscan-core      multi-word          agentscan core            yes    1     9      yes
multi-billing-worker-src  multi-word          billing worker src        yes    1     9      yes
multi-mega-gateway        multi-word          mega gateway              yes    1     9      yes

## Null-expected (reported separately, recall-exempt)
id            category   query               cands
------------  ---------  ------------------  -----
none-xyzzy    no-answer  xyzzyplugh          14
none-k8s      no-answer  kubernetes-prod-eu  12
none-quux     no-answer  quuxfrobnicate      12
none-payroll  no-answer  payroll             4
none-vpn      no-answer  vpnconfig           12

## Recall misses (expected not in candidate list)
- abbr-papermario [abbreviation] query='papermario' expected=~/emu/pm64-decomp
```

## Reading the results — product findings

- **Candidate generation is not the bottleneck.** Recall is 97.8%; the intended
  directory is almost always in the list, usually at rank 1-2. If zdr "almost
  never works," the failure is downstream of candidate generation (model
  selection or prompt), not the candidate stage — for these categories.
- **The one recall failure is real and expected.** `abbr-papermario`
  (`papermario` -> `pm64-decomp`) has zero lexical overlap between query and
  directory name, so the candidate builder ranks it purely on frecency and it
  drops below the limit in a bulky DB. Semantic aliases like this cannot be
  recovered by the current lexical candidate stage at all — the right directory
  never reaches the model. This is a candidate-stage product gap, not a corpus
  bug; the case is kept and flagged.
- **The lexical heuristic already wins 78% of the time — but fails exactly
  where the product is supposed to earn its keep.** `lexwin` is `0/5` for
  `stale-decoy` (a naive top-lexical pick *always* selects the stale backup
  copy) and misses on the hard disambiguation traps (`abbr-ascan`, `land-ds`,
  `esc-api`, `esc-auth`). These are precisely the cases where a backend must
  outperform substring ranking; live mode measures whether it does.
