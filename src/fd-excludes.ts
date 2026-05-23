import { relative, sep } from "node:path";

export function fdExcludeArgs(input: { roots: string[]; excludeRoots: string[] }): string[] {
  const patterns = new Set<string>();
  for (const excludeRoot of input.excludeRoots) {
    for (const root of input.roots) {
      const pattern = fdExcludePattern(root, excludeRoot);
      if (pattern) {
        patterns.add(pattern);
      }
    }
  }
  return [...patterns].flatMap((pattern) => ["--exclude", pattern]);
}

function fdExcludePattern(root: string, excludeRoot: string): string | null {
  if (excludeRoot === root) {
    return "**";
  }
  if (!isPathInside(excludeRoot, root)) {
    return null;
  }
  const path = relative(root, excludeRoot).split(sep).filter(Boolean).join("/");
  return path.length > 0 ? `/${path}` : "**";
}

function isPathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
