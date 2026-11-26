import { readConfig, writeConfig } from "./config";
import { load } from "./files";
import { validate, type Problem } from "./validate";
import { catalogueOf } from "./catalogue";

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

export function buildBundle(root: string, opts: { dryRun?: boolean; overwrite?: boolean } = {}) {
  const config = readConfig(root);
  const loaded = load(root);
  const problems = validate(loaded, config).filter((p) => p.level === "error");
  if (problems.length) throw new ImportError(`Fix ${problems.length} error${problems.length === 1 ? "" : "s"} first (run groundwork validate).`, problems);
  const { activity: _activity, risks, ...items } = loaded.items;
  void _activity;
  // The web app's import drops kinds it doesn't know, so a folder with risks waits until it takes them.
  if (risks.length) {
    throw new ImportError(
      `This folder has ${risks.length} risk${risks.length === 1 ? "" : "s"}, and the web app's import doesn't carry risks yet. Wait for the groundwork-mcp release that migrates them, so nothing is lost.`,
    );
  }
  // The web app knows products by name: send each requirement's product as its title, not its id (PRD-0001).
  const titles = new Map(loaded.products.map((p) => [p.id, p.title]));
  items.requirements = items.requirements.map((r) => (r.product && titles.has(r.product) ? { ...r, product: titles.get(r.product) } : r));
  return {
    format: BUNDLE_FORMAT,
    schemaVersion: 1,
    config: (() => {
      // The web app takes flat lists, so the catalogue is flattened: areas across products, product titles.
      const c = catalogueOf(config, loaded.products);
      return { name: config.name, productAreas: c.areas.map(({ id, label }) => ({ id, label })), products: c.productNames, people: config.people };
    })(),
    items,
    dryRun: Boolean(opts.dryRun),
    overwrite: Boolean(opts.overwrite),
  };
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
  if (!res.ok) throw new ImportError((data as { error?: { message?: string } }).error?.message ?? `The import failed (${res.status}).`);
  const report = data as ImportReport;
  if (!report.dryRun) writeConfig(opts.root, { ...readConfig(opts.root), migrated: report.url });
  return report;
}
