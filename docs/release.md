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

Install channels such as Homebrew or a curl-based installer are not implemented yet.
