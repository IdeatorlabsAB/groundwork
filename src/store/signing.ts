import { execFileSync } from "node:child_process";
import type { Collections } from "../core/collections";
import type { Catalogue } from "./catalogue";
import { branchesOf, type Config, type Person } from "./config";
import type { Product } from "./products";
import { loadResults, resultsFor } from "./results";
import { activeRecord, buildRecord, loadRecords, recordPath, writeRecord, type SignOffRecord } from "./signoff";

/**
 * Signing a version off: judge it on what it holds now, refuse it with blockers unless an owner justifies it, and
 * work out the record and where it goes before anything is written, so a refusal changes nothing.
 */

export class GateError extends Error {}

const MAX_JUSTIFICATION = 5000;

/**
 * Fetch the results branch, so a stale cached pass can't hide a newer failure. Never fails: without a network, or
 * without the branch, the results are read as last fetched and the record says so.
 */
export function fetchResults(root: string, config: Config): { fetched: boolean; commit: string | null; warning?: string } {
  const { resultsBranch } = branchesOf(config);
  const run = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let fetched = false;
  let warning: string | undefined;
  try {
    run(["rev-parse", "--git-dir"]);
    // No origin, no results branch to fetch: nothing to warn about.
    run(["remote", "get-url", "origin"]);
  } catch {
    return { fetched: false, commit: null };
  }
  try {
    run(["ls-remote", "--exit-code", "origin", `refs/heads/${resultsBranch}`]);
    run(["fetch", "-q", "--depth=1", "origin", `+refs/heads/${resultsBranch}:refs/remotes/origin/${resultsBranch}`]);
    fetched = true;
  } catch (e) {
    // Exit 2: the remote has no results branch yet, which is fine. Anything else: the network or the remote failed.
    if ((e as { status?: number }).status !== 2) warning = `Couldn't fetch ${resultsBranch}; CI results are as last fetched.`;
  }
  let commit: string | null = null;
  try {
    commit = run(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${resultsBranch}`]) || null;
  } catch {
    commit = null;
  }
  return { fetched, commit, ...(warning ? { warning } : {}) };
}

export function lockedBy(root: string, product: Product, version: string): string | undefined {
  return activeRecord(loadRecords(root).records, product.id, version)?.file;
}

/** "Acme app 1.0 is signed off (…). Withdraw the sign-off first …", or nothing. `how` names the way to withdraw. */
export function lockMessage(root: string, product: Product, version: string, how = "withdraw_release"): string | undefined {
  const file = lockedBy(root, product, version);
  return file ? `${product.title} ${version} is signed off (${file}). Withdraw the sign-off first (${how}), then sign off again.` : undefined;
}

export interface PreparedSignOff {
  record: SignOffRecord;
  /** Where the record goes. */
  file: string;
  /** The product with the version pointing at its record. */
  product: Product;
  warnings: string[];
}

/** `state` and `product` are as they'll be after the release: the version released, its requirements shipped. */
export function prepareSignOff(args: {
  root: string;
  config: Config;
  state: Collections;
  catalogue: Catalogue;
  product: Product;
  version: string;
  actor: { id: string; person?: Person };
  now: string;
  justification?: string;
}): PreparedSignOff {
  const { root, config, product, version } = args;
  const justification = args.justification?.trim().slice(0, MAX_JUSTIFICATION) || undefined;
  const fetch = fetchResults(root, config);
  const record = buildRecord({
    state: args.state,
    catalogue: args.catalogue,
    config,
    product,
    version,
    tests: resultsFor(loadResults(root, config), product.id, version),
    fetch,
    actor: args.actor.id,
    now: args.now,
    justification,
  });
  // A baseline documents what exists: its blockers are recorded, not enforced.
  if (record.blockers.length && record.kind !== "baseline") {
    if (!justification) {
      const n = record.blockers.length;
      throw new GateError(
        [`${product.title} ${version} isn't ready: ${n} blocker${n === 1 ? "" : "s"}.`, ...record.blockers.map((b) => `- ${b.message}`), "Link tests with link_code_tests or link_test_cases, and record their results (CI: groundwork results add; test tools: record_test_results). Or an owner can release it anyway with overrideJustification."].join("\n"),
      );
    }
    if (args.actor.person?.role !== "owner") throw new GateError("Only an owner can release over blockers.");
  }
  const file = recordPath(root, product.id, version);
  return {
    record,
    file,
    product: { ...product, versions: product.versions.map((v) => (v.version === version ? { ...v, signOff: file } : v)) },
    warnings: fetch.warning ? [fetch.warning] : [],
  };
}

/** Write the record first: if it can't be written, nothing else is. */
export function commitSignOff(root: string, prepared: PreparedSignOff) {
  writeRecord(root, prepared.file, prepared.record);
}
