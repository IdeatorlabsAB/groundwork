import { catalogueOf, findProduct, type Catalogue } from "./store/catalogue";
import { readConfig, resolveActor } from "./store/config";
import { load, save } from "./store/files";
import { writeProduct, type Product } from "./store/products";
import { correctRelease, ReleaseError, releaseReport, releaseVersion, renderReleaseReport } from "./store/release";
import { renderRecord, reportView } from "./store/report";
import { RISK_COLUMNS, riskRegisterRows, toCsv, TRACEABILITY_COLUMNS, traceabilityRows } from "./core/report-rows";

/**
 * `groundwork release` and `groundwork report release`, as functions that return their output, so they can be
 * tested without a build.
 */

export interface ReleaseArgs {
  product?: string;
  version: string;
  shipped?: string[];
  removed?: string[];
  moveRest?: string;
  correct?: boolean;
  reason?: string;
  add?: string[];
  remove?: string[];
  addObsolete?: string[];
  removeObsolete?: string[];
}

type Out = { code: number; lines: string[] };

function productFor(c: Catalogue, value: string | undefined): Product | string {
  if (!c.products.length) return c.legacy ? 'Products are still in config.yml. Run "groundwork migrate" first.' : "There are no products yet.";
  if (value) return findProduct(c, value) ?? `Unknown product "${value}". Products: ${c.productNames.join(", ")}.`;
  if (c.products.length > 1) return `Name the product: one of ${c.products.map((p) => `${p.id} (${p.title})`).join(", ")}.`;
  return c.products[0];
}

export function runReleaseCommand(root: string, args: ReleaseArgs): Out {
  const config = readConfig(root);
  if (config.migrated) return { code: 1, lines: [`This folder was imported into the web app (${config.migrated}); release there.`] };
  const actor = resolveActor(root, config);
  if (actor.person?.role === "viewer") return { code: 1, lines: ["Viewers can't release."] };
  if (!actor.person) {
    return { code: 1, lines: [`Releasing is recorded with who did it, so it needs a person from groundwork/config.yml people (owner or editor). You're "${actor.id}": set GROUNDWORK_USER, or add your git email there.`] };
  }
  // A release can't be undone, so ambiguous commands are refused rather than guessed.
  const correctionFlags = [args.reason, args.add, args.remove, args.addObsolete, args.removeObsolete].some((x) => x !== undefined);
  if (!args.correct && correctionFlags) return { code: 1, lines: ["--reason, --add, --remove, --add-obsolete and --remove-obsolete are for corrections: add --correct."] };
  if (args.correct && (args.shipped !== undefined || args.removed !== undefined)) {
    return { code: 1, lines: ["--shipped and --removed are for releasing; a correction uses --add, --remove, --add-obsolete and --remove-obsolete."] };
  }
  if (!args.correct && args.shipped === undefined) return { code: 1, lines: ['Say what shipped: --shipped REQ-0001,REQ-0002 (or --shipped "" to release a version with nothing in it).'] };
  const loaded = load(root);
  const catalogue = catalogueOf(config, loaded.products);
  const p = productFor(catalogue, args.product);
  if (typeof p === "string") return { code: 1, lines: [p] };
  const now = new Date().toISOString();
  try {
    const out = args.correct
      ? correctRelease(loaded.items.requirements, catalogue, {
          product: p,
          version: args.version,
          reason: args.reason ?? "",
          addShipped: args.add,
          removeShipped: args.remove,
          addObsolete: args.addObsolete,
          removeObsolete: args.removeObsolete,
          moveTo: args.moveRest,
          actor: actor.id,
          now,
        })
      : releaseVersion(loaded.items.requirements, catalogue, {
          product: p,
          version: args.version,
          shipped: args.shipped ?? [],
          removed: args.removed,
          moveTo: args.moveRest,
          actor: actor.id,
          now,
        });
    const productPath = loaded.paths.get(p.id);
    const files = save(root, loaded, { ...loaded.items, requirements: out.requirements });
    files.push(writeProduct(root, out.product, productPath));
    const after = catalogueOf(config, catalogue.products.map((x) => (x.id === p.id ? out.product : x)));
    const report = renderReleaseReport(releaseReport(out.requirements, after, out.product, args.version));
    return { code: 0, lines: [...report.trimEnd().split("\n"), "", `${args.correct ? "Corrected" : "Released"}. Files changed: ${files.join(", ")}`] };
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    const lines = [e.message];
    if (/already released/.test(e.message)) {
      lines.push(`On the command line: groundwork release ${args.version} --correct --reason "…" [--add ID] [--remove ID] [--move-rest <version>]`);
    }
    return { code: 1, lines };
  }
}

export function runReportCommand(root: string, args: { product?: string; version: string; json?: boolean; format?: string; table?: string }): Out {
  const config = readConfig(root);
  const loaded = load(root);
  const catalogue = catalogueOf(config, loaded.products);
  const p = productFor(catalogue, args.product);
  if (typeof p === "string") return { code: 1, lines: [p] };
  const format = args.format ?? "md";
  if (!["md", "csv"].includes(format)) return { code: 1, lines: [`--format is md or csv, not "${format}".`] };
  const table = args.table ?? "traceability";
  if (!["traceability", "risks"].includes(table)) return { code: 1, lines: [`--table is traceability or risks, not "${table}".`] };
  if (!p.versions.some((v) => v.version === args.version)) return { code: 1, lines: [`${args.version} isn't a version of ${p.title}.`] };
  const { record, status } = reportView(root, loaded, p, args.version);
  if (args.json) return { code: 0, lines: [JSON.stringify({ status, ...record }, null, 2)] };
  if (format === "csv") {
    const csv = table === "risks" ? toCsv(RISK_COLUMNS, riskRegisterRows(record) as never) : toCsv(TRACEABILITY_COLUMNS, traceabilityRows(record) as never);
    return { code: 0, lines: csv.replace(/\r\n$/, "").split("\r\n") };
  }
  return { code: 0, lines: renderRecord(record, status).trimEnd().split("\n") };
}
