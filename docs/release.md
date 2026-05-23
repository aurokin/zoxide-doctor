# Release Process

Release archives are built by GitHub Actions when a `vX.Y.Z` tag matching `package.json` is pushed.

Each release includes Bun-compiled `zdr` archives for:

- macOS arm64
- macOS x64
- Linux arm64
- Linux x64 baseline

Each release also includes `SHA256SUMS`.

Before tagging, run:

```bash
bun run verify
bun run release:build
```

## Installer

The curl-based installer downloads the matching release archive, verifies it against `SHA256SUMS`, and installs `zdr` into `~/.local/bin` by default:

```bash
curl -fsSL https://raw.githubusercontent.com/aurokin/zoxide-doctor/main/scripts/install.sh | sh
```

Install a specific version or directory:

```bash
curl -fsSL https://raw.githubusercontent.com/aurokin/zoxide-doctor/main/scripts/install.sh | sh -s -- --version 0.1.0 --dir "$HOME/bin"
```

Homebrew is not implemented yet.
