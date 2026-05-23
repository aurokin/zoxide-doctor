# Changelog

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
