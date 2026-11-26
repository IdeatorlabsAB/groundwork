// Ported from centropic-prototype src/lib/code-refs.ts. Keep in step with it.
/**
 * Code references: where a requirement's behaviour or a risk's hazard lives, as repo-relative paths with an
 * optional #symbol or :line (or :start-end). Used to tell an agent which requirements and risks a change touches.
 */

/** The path part of a code reference, without #symbol, :line, a leading ./ or a trailing /. */
export function refPath(ref: string): string {
  return ref
    .trim()
    .replace(/#.*$/, "")
    .replace(/:\d+(-\d+)?$/, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/** Whether a reference touches a path: the same file, a folder containing it, or a file inside a folder given as the path. */
export function touches(ref: string, path: string): boolean {
  const r = refPath(ref);
  const p = refPath(path);
  if (!r) return false;
  // The repository root ("", "." or "./") contains every reference.
  if (!p || p === ".") return true;
  return r === p || p.startsWith(`${r}/`) || r.startsWith(`${p}/`);
}
