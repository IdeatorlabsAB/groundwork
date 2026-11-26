// Ported from centropic-prototype src/lib/ci/match-tests.ts. Keep in step with it.
import { refPath } from "./code-refs";
import type { Requirement } from "./types";
import type { CodeTestResult, CodeTestStatus } from "./junit";

/**
 * The outcome of each code test linked to a requirement, in a CI run's results. A linked test matches a result in
 * the same file whose name is the linked name, or ends with it after " > " (runners like vitest report the full
 * title, "describe > it"). When a test ran more than once, its last result counts.
 */
/** Whether a result is the run of a linked code test: the same file, and the linked name or a full title ending in it. */
export function isRunOf(link: { path: string; name: string }, result: { path: string; name: string }): boolean {
  return refPath(link.path) === result.path && (result.name === link.name || result.name.endsWith(` > ${link.name}`));
}

export function matchCodeTests(
  reqs: Requirement[],
  results: CodeTestResult[],
): { requirementKey: string; path: string; name: string; status: CodeTestStatus | "not-run" }[] {
  return reqs.flatMap((r) =>
    (r.codeTests ?? []).map((t) => {
      const hit = results.findLast((x) => isRunOf(t, x));
      return { requirementKey: r.id, path: t.path, name: t.name, status: hit?.status ?? "not-run" };
    }),
  );
}
