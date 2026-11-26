import { readConfig, writeConfig } from "./config";
import { load } from "./files";
import { validate, type Problem } from "./validate";
import { catalogueOf, productOf } from "./catalogue";
import { loadResults } from "./results";
import { loadRecords } from "./signoff";
import { isRunOf } from "../core/match-tests";
import type { CodeTestResult } from "../core/junit";

/**
 * Moving a project into the Groundwork web app: send every item to its /api/import endpoint, then mark the folder
 * as migrated so local tools stop writing (the web app is where changes go from then on).
 */

export const BUNDLE_FORMAT = "groundwork-files";
/** Hosting platforms cap request bodies around 4.5 MB. */
const MAX_BYTES = 4_000_000;

export interface ImportReport {
  workspace: string;
  url: string;
  dryRun: boolean;
  created: number;
  updated: number;
  skipped: number;
  addedAreas: string[];
  addedProducts: string[];
  warnings: string[];
  ids: Record<string, string>;
}

export class ImportError extends Error {
  constructor(
    message: string,
    readonly problems: Problem[] = [],
  ) {
    super(message);
  }
}

/**
 * Everything in the folder, for the web app's /api/import: items (risks included), product versions, sign-off records
 * as they are, the CI runs that count (the newest window, from CI on the default branch) and test-tool runs.
 */
export function buildBundle(root: string, opts: { dryRun?: boolean; overwrite?: boolean } = {}) {
  const config = readConfig(root);
  const loaded = load(root);
  const problems = validate(loaded, config).filter((p) => p.level === "error");
  if (problems.length) throw new ImportError(`Fix ${problems.length} error${problems.length === 1 ? "" : "s"} first (run groundwork validate).`, problems);
  const { activity: _activity, ...items } = loaded.items;
  void _activity;
  const catalogue = catalogueOf(config, loaded.products);
  // The web app knows products by name: send each one's title, with the local id beside it.
  const titles = new Map(loaded.products.map((p) => [p.id, p.title]));
  items.requirements = items.requirements.map((r) => {
    const p = productOf(catalogue, r);
    return p ? { ...r, product: p.title, productId: p.id } : r.product && titles.has(r.product) ? { ...r, product: titles.get(r.product) } : r;
  });
  items.risks = items.risks.map((r) => (r.product && titles.has(r.product) ? { ...r, product: titles.get(r.product)!, productId: r.product } : r));
  const results = loadResults(root, config);
  const linked = items.requirements.flatMap((r) => r.codeTests ?? []);
  const { records } = loadRecords(root);
  return {
    format: BUNDLE_FORMAT,
    schemaVersion: 2,
    config: (() => {
      // The web app takes flat lists, so the catalogue is flattened: areas across products, product titles.
      return { name: config.name, productAreas: catalogue.areas.map(({ id, label }) => ({ id, label })), products: catalogue.productNames, people: config.people };
    })(),
    items,
    versions: loaded.products.flatMap((p) => p.versions.map((v) => ({ productId: p.id, product: p.title, ...v }))),
    records,
    // Runs from outside CI never count as evidence, so they aren't sent. Each run keeps the results of linked tests,
    // and one result for every other file in it, so the web app still knows which files ran (a linked test missing from
    // a newer run of its file was deleted), and a big project's runs stay well under the import's size cap.
    codeRuns: results.codeRuns.filter((r) => r.source === "ci").map((r) => trimRun(r, linked)),
    testRuns: results.testRuns.map((r) => ({ ...r, productId: r.product, product: titles.get(r.product) ?? r.product })),
    dryRun: Boolean(opts.dryRun),
    overwrite: Boolean(opts.overwrite),
  };
}

/** A CI run with only what readiness reads: linked tests' results, and one result for each other file it ran. */
function trimRun<R extends { results: CodeTestResult[] }>(run: R, linked: { path: string; name: string }[]): R {
  const out: CodeTestResult[] = [];
  const files = new Set<string>();
  for (const res of run.results) {
    if (linked.some((t) => isRunOf(t, res))) {
      out.push(res);
      files.add(res.path);
    }
  }
  for (const res of run.results) {
    if (files.has(res.path)) continue;
    out.push(res);
    files.add(res.path);
  }
  return { ...run, results: out };
}

export async function runImport(opts: {
  root: string;
  /** The web app's address, e.g. https://groundwork.example.com */
  to: string;
  token: string;
  dryRun?: boolean;
  overwrite?: boolean;
  fetch?: typeof fetch;
}): Promise<ImportReport> {
  let origin: string;
  try {
    const u = new URL(opts.to);
    if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) throw new Error();
    origin = u.origin;
  } catch {
    throw new ImportError(`--to must be the web app's https address, e.g. https://groundwork.example.com (got "${opts.to}").`);
  }
  if (!/^gw_[A-Za-z0-9_-]{20,100}$/.test(opts.token)) {
    throw new ImportError("That doesn't look like a Groundwork agent token (gw_…). Create one in the web app: Settings → Connect an agent.");
  }
  const body = JSON.stringify(buildBundle(opts.root, opts));
  if (body.length > MAX_BYTES) throw new ImportError(`This project is ${(body.length / 1e6).toFixed(1)} MB, more than an import can take (4 MB).`);

  const res = await (opts.fetch ?? fetch)(`${origin}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
    body,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError(`The web app answered ${res.status} without JSON. Is ${origin} a Groundwork web app?`);
  }
  if (!res.ok) {
    const message = (data as { error?: { message?: string } }).error?.message ?? `The import failed (${res.status}).`;
    // A web app from before this format answers that schemaVersion must be 1.
    if (res.status === 400 && /schemaVersion/.test(message)) throw new ImportError("Update the Groundwork web app first: it doesn't take this folder's format yet.");
    throw new ImportError(message);
  }
  const report = data as ImportReport;
  if (!report.dryRun) writeConfig(opts.root, { ...readConfig(opts.root), migrated: report.url });
  return report;
}
