import { execFileSync } from "node:child_process";
import { releaseReadiness } from "../core/readiness";
import { initialLevel } from "../core/risk";
import type { Blocker } from "../core/types";
import { catalogueOf } from "./catalogue";
import { branchesOf, matrixOf, readConfig } from "./config";
import type { Loaded } from "./files";
import type { Product } from "./products";
import { loadResults, resultsFor } from "./results";
import { activeRecord, loadRecords, versionScope } from "./signoff";

/** Whether a version can go out, as `check_release` and `groundwork check release` report it. Offline: never fetches. */
export type CheckResult =
  | {
      version: string;
      status: "planned";
      ready: boolean;
      blockers: Blocker[];
      warnings: string[];
      results: { read: string[]; commit: string | null; hint: string };
      scope: { requirements: string[]; risks: string[] };
    }
  | { version: string; status: "signed-off"; record: string; signedAt: string; signedOffBy: { id: string; name: string }; blockers: Blocker[]; overrideJustification?: string }
  | { version: string; status: "released"; note: "Released before sign-off records" | "Its sign-off was withdrawn"; signOff: "sign_off_release" };

export function checkRelease(root: string, loaded: Loaded, product: Product, version: string): CheckResult {
  const { records } = loadRecords(root);
  const active = activeRecord(records, product.id, version);
  if (active) {
    return {
      version,
      status: "signed-off",
      record: active.file,
      signedAt: active.signedAt,
      signedOffBy: active.signedOffBy,
      blockers: active.blockers,
      ...(active.overrideJustification ? { overrideJustification: active.overrideJustification } : {}),
    };
  }
  if (product.versions.find((v) => v.version === version)?.status === "released") {
    const withdrawn = records.some((r) => r.product.id === product.id && r.version === version && r.withdrawnAt);
    return { version, status: "released", note: withdrawn ? "Its sign-off was withdrawn" : "Released before sign-off records", signOff: "sign_off_release" };
  }
  const config = readConfig(root);
  const catalogue = catalogueOf(config, loaded.products);
  const m = matrixOf(config);
  const scope = versionScope(loaded.items, catalogue, product, version);
  const results = loadResults(root, config);
  const { blockers } = releaseReadiness(m, scope, loaded.items.requirements, resultsFor(results, product.id, version));
  // A known gap, kept for parity with the web app: a mitigation outside the version doesn't block, so say so.
  const warnings = scope.risks
    .filter((k) => initialLevel(m, k) === "high")
    .flatMap((k) =>
      k.mitigationIds
        .map((id) => loaded.items.requirements.find((r) => r.id === id))
        .filter((r) => r && !r.releasedIn && !scope.requirements.some((x) => x.id === r.id))
        .map((r) => `Risk "${k.title}": its mitigation "${r!.title}" isn't in this version.`),
    );
  const { resultsBranch } = branchesOf(config);
  let commit: string | null = null;
  try {
    commit = execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${resultsBranch}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    commit = null;
  }
  return {
    version,
    status: "planned",
    ready: blockers.length === 0,
    blockers,
    warnings,
    results: { read: results.read, commit, hint: `Run git fetch origin ${resultsBranch} for the latest CI results.` },
    scope: { requirements: scope.requirements.map((r) => r.id), risks: scope.risks.map((r) => r.id) },
  };
}
