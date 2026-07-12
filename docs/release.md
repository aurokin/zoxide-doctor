# Release Process

Release archives are built by GitHub Actions when a `vX.Y.Z` tag matching `package.json` is pushed. The current release is `v0.2.0`.

Each release includes Bun-compiled `zdr` archives for:

- macOS arm64
- macOS x64
- Linux arm64
- Linux x64 baseline

Each release also includes `SHA256SUMS`.

Before tagging, run:

```bash
bun run release:prepare
```

This verifies the project, builds release archives, generates `Formula/zoxide-doctor.rb`, checks Ruby syntax, and runs `brew style` when Homebrew is available.

## Installer

The curl-based installer downloads the matching release archive, verifies it against `SHA256SUMS`, and installs `zdr` into `~/.local/bin` by default:

```bash
curl -fsSL https://raw.githubusercontent.com/aurokin/zoxide-doctor/main/scripts/install.sh | sh
```

Install a specific version or directory:

```bash
curl -fsSL https://raw.githubusercontent.com/aurokin/zoxide-doctor/main/scripts/install.sh | sh -s -- --version 0.2.0 --dir "$HOME/bin"
```

Homebrew install is not available yet: the formula is generated (see below), but it has not been copied into the tap.

## Homebrew Formula

After release artifacts exist locally, generate the formula:

```bash
bun run release:build
bun run release:formula
```

This writes `Formula/zoxide-doctor.rb` from `package.json` and `release/SHA256SUMS`. Copy that formula into the Homebrew tap after the matching GitHub release is published.
