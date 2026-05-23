#!/usr/bin/env sh
set -eu

repo="aurokin/zoxide-doctor"
version="latest"
install_dir="${ZDR_INSTALL_DIR:-$HOME/.local/bin}"
print_plan=0

usage() {
  cat <<'USAGE'
Install Zoxide Doctor.

Usage:
  install.sh [--version <version>] [--dir <path>] [--repo <owner/repo>] [--print-plan]

Defaults:
  --version latest
  --dir     ~/.local/bin
  --repo    aurokin/zoxide-doctor

Environment overrides for tests and advanced use:
  ZDR_INSTALL_OS
  ZDR_INSTALL_ARCH
  ZDR_INSTALL_VERSION
  ZDR_INSTALL_DIR
  ZDR_INSTALL_REPO
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      if [ "$#" -lt 2 ]; then
        echo "zdr install: --version requires a value" >&2
        exit 2
      fi
      version="$2"
      shift 2
      ;;
    --version=*)
      version="${1#--version=}"
      shift
      ;;
    --dir)
      if [ "$#" -lt 2 ]; then
        echo "zdr install: --dir requires a value" >&2
        exit 2
      fi
      install_dir="$2"
      shift 2
      ;;
    --dir=*)
      install_dir="${1#--dir=}"
      shift
      ;;
    --repo)
      if [ "$#" -lt 2 ]; then
        echo "zdr install: --repo requires a value" >&2
        exit 2
      fi
      repo="$2"
      shift 2
      ;;
    --repo=*)
      repo="${1#--repo=}"
      shift
      ;;
    --print-plan)
      print_plan=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "zdr install: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -n "${ZDR_INSTALL_VERSION:-}" ]; then
  version="$ZDR_INSTALL_VERSION"
fi

if [ -n "${ZDR_INSTALL_REPO:-}" ]; then
  repo="$ZDR_INSTALL_REPO"
fi

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "zdr install: required command not found: $1" >&2
    exit 1
  fi
}

detect_os() {
  if [ -n "${ZDR_INSTALL_OS:-}" ]; then
    printf '%s\n' "$ZDR_INSTALL_OS"
    return
  fi
  uname -s | tr '[:upper:]' '[:lower:]'
}

detect_arch() {
  if [ -n "${ZDR_INSTALL_ARCH:-}" ]; then
    printf '%s\n' "$ZDR_INSTALL_ARCH"
    return
  fi
  uname -m
}

artifact_for_platform() {
  os="$1"
  arch="$2"

  case "$os:$arch" in
    darwin:arm64|darwin:aarch64)
      printf '%s\n' "darwin-arm64"
      ;;
    darwin:x86_64|darwin:amd64)
      printf '%s\n' "darwin-x64"
      ;;
    linux:arm64|linux:aarch64)
      printf '%s\n' "linux-arm64"
      ;;
    linux:x86_64|linux:amd64)
      printf '%s\n' "linux-x64-baseline"
      ;;
    *)
      echo "zdr install: unsupported platform: $os $arch" >&2
      exit 1
      ;;
  esac
}

normalize_version() {
  value="$1"
  case "$value" in
    v*)
      printf '%s\n' "${value#v}"
      ;;
    *)
      printf '%s\n' "$value"
      ;;
  esac
}

resolve_latest_version() {
  effective_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")"
  resolved="$(printf '%s\n' "$effective_url" | sed -n 's#.*/releases/tag/v\{0,1\}\([^/?#]*\).*#\1#p')"
  if [ -z "$resolved" ]; then
    echo "zdr install: could not resolve latest release for $repo" >&2
    exit 1
  fi
  printf '%s\n' "$resolved"
}

checksum_cmd() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n' "sha256sum -c"
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    printf '%s\n' "shasum -a 256 -c"
    return
  fi
  echo "zdr install: required command not found: sha256sum or shasum" >&2
  exit 1
}

os="$(detect_os)"
arch="$(detect_arch)"
artifact="$(artifact_for_platform "$os" "$arch")"

if [ "$version" = "latest" ] && [ "$print_plan" -eq 0 ]; then
  need_cmd curl
  version="$(resolve_latest_version)"
fi

if [ "$version" != "latest" ]; then
  version="$(normalize_version "$version")"
fi

tag="v$version"
archive="zdr-$tag-$artifact.tar.gz"
release_base="https://github.com/$repo/releases/download/$tag"

if [ "$print_plan" -eq 1 ]; then
  printf 'repo=%s\n' "$repo"
  printf 'version=%s\n' "$version"
  printf 'tag=%s\n' "$tag"
  printf 'os=%s\n' "$os"
  printf 'arch=%s\n' "$arch"
  printf 'artifact=%s\n' "$artifact"
  printf 'archive=%s\n' "$archive"
  printf 'archive_url=%s/%s\n' "$release_base" "$archive"
  printf 'checksums_url=%s/SHA256SUMS\n' "$release_base"
  printf 'install_dir=%s\n' "$install_dir"
  exit 0
fi

need_cmd curl
need_cmd tar
check_command="$(checksum_cmd)"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/zdr-install.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

archive_path="$tmp_dir/$archive"
checksums_path="$tmp_dir/SHA256SUMS"

echo "Downloading $archive"
curl -fsSL "$release_base/$archive" -o "$archive_path"
curl -fsSL "$release_base/SHA256SUMS" -o "$checksums_path"

(
  cd "$tmp_dir"
  checksum_line="$(grep "  $archive\$" SHA256SUMS || true)"
  if [ -z "$checksum_line" ]; then
    echo "zdr install: checksum missing for $archive" >&2
    exit 1
  fi
  printf '%s\n' "$checksum_line" | $check_command
)

tar -xzf "$archive_path" -C "$tmp_dir"
mkdir -p "$install_dir"
install -m 755 "$tmp_dir/zdr-$tag-$artifact/zdr" "$install_dir/zdr"

echo "Installed zdr to $install_dir/zdr"
if ! command -v zdr >/dev/null 2>&1; then
  echo "Note: $install_dir is not on PATH in this shell." >&2
fi
"$install_dir/zdr" --version
