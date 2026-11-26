import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Collections } from "../core/collections";
import { mitigatedIn, releaseReadiness, type Scope, type Tests } from "../core/readiness";
import { kindOf } from "../core/requirements";
import { initialLevel, residualLevel } from "../core/risk";
import { testStatus, type RequirementTestStatus } from "../core/tests";
import type { Blocker, CodeRunInfo, Requirement, Risk, RiskLevel, RiskMatrix, TestRunInfo } from "../core/types";
import { productOf, type Catalogue } from "./catalogue";
import { matrixOf, type Config } from "./config";
import type { Product } from "./products";
import { releaseReport, type ReleaseReport } from "./release";

/**
 * Sign-off records: what a version looked like when it was signed off, frozen. One JSON file per sign-off in
 * groundwork/releases/, never rewritten except to record a withdrawal. The local form of the web app's ReleaseRecord;
 * the release report of a signed-off version is read from it, so it never drifts as files change.
 */

export const RELEASES_DIR = "groundwork/releases";

export const RECORD_FIELDS = [
  "id",
  "title",
  "kind",
  "story",
  "status",
  "acceptanceCriteria",
  "approvedBy",
  "approvedAt",
  "riskIds",
  "stakeholderIds",
  "testCases",
  "codeTests",
  "tickets",
  "plannedFor",
  "releasedIn",
] as const;
export type RecordRequirement = Pick<Requirement, (typeof RECORD_FIELDS)[number]>;
export type RecordRisk = Risk & { initialLevel: RiskLevel | null; residualLevel: RiskLevel | null; mitigated: boolean };

export interface SignOffRecord {
  schemaVersion: 1;
  /** baseline: every requirement documents an existing product; its tests weren't checked. */
  kind: "release" | "baseline";
  product: { id: string; title: string };
  version: string;
  signedAt: string;
  signedOffBy: { id: string; name: string };
  /** Names of everyone in config.yml as of sign-off, so the record survives people leaving. */
  people: Record<string, string>;
  overrideJustification?: string;
  matrix: RiskMatrix;
  risks: RecordRisk[];
  /** The version's requirements, plus the mitigations of its risks. */
  requirements: RecordRequirement[];
  blockers: Blocker[];
  tests?: {
    fetchedAt: string;
    /** Whether the results branch was fetched just before; false means it was read as last fetched. */
    fetched: boolean;
    /** The results branch commit that was read, if there was one. */
    resultsCommit: string | null;
    runs: TestRunInfo[];
    codeRuns: CodeRunInfo[];
    requirements: Record<string, RequirementTestStatus>;
  };
  report: ReleaseReport;
  withdrawnAt?: string;
  withdrawnBy?: string;
  withdrawReason?: string;
}

const versionSlug = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "_";

const isActive = (r: Requirement) => r.status !== "obsolete";

/** A version's scope: its live solution requirements (planned for it, or shipped in it once released) and its risks. */
export function versionScope(state: Collections, catalogue: Catalogue, product: Product, version: string): Scope {
  const released = product.versions.find((v) => v.version === version)?.status === "released";
  return {
    requirements: state.requirements
      .filter((r) => kindOf(r) === "solution" && isActive(r) && productOf(catalogue, r)?.id === product.id)
      .filter((r) => (released ? r.releasedIn === version : r.plannedFor === version && !r.releasedIn))
      .sort((a, b) => a.id.localeCompare(b.id)),
    risks: state.risks.filter((r) => r.product === product.id && r.versions.includes(version)).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

const pick = (r: Requirement): RecordRequirement =>
  Object.fromEntries(RECORD_FIELDS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])) as RecordRequirement;

export function buildRecord(args: {
  state: Collections;
  catalogue: Catalogue;
  config: Config;
  product: Product;
  version: string;
  /** The version's results (resultsFor). Ignored for a baseline. */
  tests: Tests;
  fetch: { fetched: boolean; commit: string | null };
  actor: string;
  now: string;
  justification?: string;
}): SignOffRecord {
  const { state, catalogue, config, product, version, fetch, actor, now } = args;
  const m = matrixOf(config);
  const scope = versionScope(state, catalogue, product, version);
  const baseline = scope.requirements.length > 0 && scope.requirements.every((r) => r.origin === "existing-product");
  const tests = baseline ? undefined : args.tests;
  const ids = new Set([...scope.requirements.map((r) => r.id), ...scope.risks.flatMap((r) => r.mitigationIds)]);
  const people = Object.fromEntries(config.people.map((p) => [p.id, p.name]));
  return {
    schemaVersion: 1,
    kind: baseline ? "baseline" : "release",
    product: { id: product.id, title: product.title },
    version,
    signedAt: now,
    signedOffBy: { id: actor, name: people[actor] ?? actor },
    people,
    ...(args.justification ? { overrideJustification: args.justification } : {}),
    matrix: m,
    risks: scope.risks.map((r) => ({ ...r, initialLevel: initialLevel(m, r), residualLevel: residualLevel(m, r), mitigated: mitigatedIn(m, r, state.requirements, scope, tests) })),
    requirements: state.requirements
      .filter((r) => ids.has(r.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(pick),
    blockers: releaseReadiness(m, scope, state.requirements, tests).blockers,
    ...(tests
      ? {
          tests: {
            fetchedAt: now,
            fetched: fetch.fetched,
            resultsCommit: fetch.commit,
            runs: tests.runs,
            codeRuns: tests.code.runs,
            requirements: Object.fromEntries(scope.requirements.map((r) => [r.id, testStatus(r, tests)])),
          },
        }
      : {}),
    report: releaseReport(state.requirements, catalogue, product, version),
  };
}

const absolute = (root: string, rel: string) => join(root, ...rel.split("/"));

export function loadRecords(root: string): { records: (SignOffRecord & { file: string })[]; problems: { file: string; message: string }[] } {
  const dir = absolute(root, RELEASES_DIR);
  const out = { records: [] as (SignOffRecord & { file: string })[], problems: [] as { file: string; message: string }[] };
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const file = posix.join(RELEASES_DIR, name);
    try {
      const data = JSON.parse(readFileSync(join(dir, name), "utf8")) as SignOffRecord;
      if (!data || typeof data !== "object" || data.schemaVersion !== 1 || typeof data.version !== "string" || typeof data.product?.id !== "string") {
        throw new Error("schemaVersion, product and version are required");
      }
      out.records.push({ ...data, file });
    } catch (e) {
      out.problems.push({ file, message: `isn't a valid sign-off record: ${(e as Error).message}` });
    }
  }
  return out;
}

/** The version's current sign-off: its latest record that isn't withdrawn. */
export function activeRecord<R extends Pick<SignOffRecord, "product" | "version" | "withdrawnAt"> & { file: string }>(records: R[], productId: string, version: string): R | undefined {
  return records
    .filter((r) => r.product.id === productId && r.version === version && !r.withdrawnAt)
    .sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }))
    .at(-1);
}

export const recordPrefix = (productId: string, version: string) => `${productId}-${versionSlug(version)}-`;

/** The next free record file for a version: PRD-0001-1-1-<n>.json, n counting the files already there. */
export function recordPath(root: string, productId: string, version: string): string {
  const prefix = recordPrefix(productId, version);
  const dir = absolute(root, RELEASES_DIR);
  const taken = existsSync(dir) ? readdirSync(dir) : [];
  let n = 1;
  for (const name of taken) {
    const m = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)\\.json$`).exec(name);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return posix.join(RELEASES_DIR, `${prefix}${n}.json`);
}

export class RecordError extends Error {}

export function writeRecord(root: string, rel: string, record: SignOffRecord) {
  const file = absolute(root, rel);
  if (existsSync(file)) throw new RecordError(`${rel} already exists.`);
  mkdirSync(absolute(root, RELEASES_DIR), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
}

/** The one change a record allows: saying it was withdrawn, by whom and why. */
export function withdrawRecord(root: string, rel: string, by: string, reason: string, now: string) {
  const file = absolute(root, rel);
  const data = JSON.parse(readFileSync(file, "utf8")) as SignOffRecord;
  if (data.withdrawnAt) throw new RecordError(`${rel} was already withdrawn on ${data.withdrawnAt.slice(0, 10)}.`);
  writeFileSync(file, `${JSON.stringify({ ...data, withdrawnAt: now, withdrawnBy: by, withdrawReason: reason }, null, 2)}\n`);
}
