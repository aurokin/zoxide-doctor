# Changelog

## 0.2.0 - 2026-07-12

- Changed the default provider to `openai-codex` / `gpt-5.6-terra` (low reasoning effort), running on ChatGPT-plan OAuth instead of an API key.
- Added a backend layer with an optional `escalation` config tier; the second recovery attempt can route to a different backend.
- Added a Claude escalation backend using the Claude Agent SDK with subscription login (API-key environment deliberately excluded).
- Added read-only import of Pi CLI OAuth logins from `~/.pi/agent/auth.json`, with fallback re-import when a stored credential stops working.
- Added `zdr provider-discover` for token-free readiness reporting across backends and tiers, including an escalation setup tip.
- Added `zdr config-escalation` to set or clear the escalation tier.
- Added recovery alias memory: picker selections and confident repairs are remembered and injected into future candidate lists; rejected suggestions are forgotten.
- Added a live evaluation suite with an adversarial filesystem corpus, offline recall mode, spend-gated live mode, repeat-consistency reporting, and a telemetry-to-case mining script.
- Improved the selection prompt for verbatim-name decoys and no-good-answer discipline (live accuracy 90% to 96% on the eval suite).
- Migrated to pi-ai 0.80 (`/compat` entrypoint), added reasoning-model token headroom, surfaced provider errors (including truncation), and worked around Codex client-identity gating of `gpt-5.6-luna`.
- Hardened auth storage with serialized writes and unique temp files.

## 0.1.0 - 2026-05-23

- Added the core no-arg recovery flow after bad `z` jumps.
- Added repeated `zdr` escalation that excludes prior wrong repairs and falls back to an `fzf` picker on the third attempt.
- Added experimental direct lookup with `zdr <query>` and local correction memory for exact query mappings.
- Added zsh, bash, and fish shell integrations that record `z` attempts and change directory only for navigation commands.
- Added configurable Pi provider/model settings with OpenRouter defaults, OAuth provider login support, and `openai-codex` provider setup.
- Added local telemetry, diagnostics, timing commands, provider benchmarks, benchmark suites, and provider usage/cost reporting.
- Added privacy redaction for home paths, emails, secrets, and token-like strings before provider prompts.
- Added strict v1 config loading, setup diagnostics, provider catalog commands, and provider smoke checks.
- Added Bun standalone executable builds, CI verification, GitHub release archive automation, checksum generation, and release preparation tooling.
- Added a curl-based release installer and Homebrew formula generation from release checksums.
