import { catalogueOf, findProduct, type Catalogue } from "./store/catalogue";
import { readConfig, resolveActor } from "./store/config";
import { load, save } from "./store/files";
import { writeProduct, type Product } from "./store/products";
import { correctRelease, ReleaseError, releaseReport, releaseVersion, renderReleaseReport } from "./store/release";
import { renderRecord, reportView } from "./store/report";
import { commitSignOff, GateError, lockMessage, prepareSignOff } from "./store/signing";
import { checkRelease } from "./store/check";
import { activeRecord, loadRecords } from "./store/signoff";

/** The gate's refusal, with the CLI's way to override it. */
const cliGate = (e: GateError) => e.message.replace("An owner can release it anyway with overrideJustification.", 'An owner can release it anyway: add --justification "…".').split("\n");

function signOffCommand(root: string, args: ReleaseArgs, actor: ReturnType<typeof resolveActor>): Out {
  const config = readConfig(root);
  const loaded = load(root);
  const catalogue = catalogueOf(config, loaded.products);
  const p = productFor(catalogue, args.product);
  if (typeof p === "string") return { code: 1, lines: [p] };
  const v = p.versions.find((x) => x.version === args.version);
  if (!v) return { code: 1, lines: [`${args.version} isn't a version of ${p.title}.`] };
  if (v.status !== "released") return { code: 1, lines: [`${p.title} ${args.version} isn't released yet: release it with --shipped, which signs it off too.`] };
  const active = activeRecord(loadRecords(root).records, p.id, args.version);
  if (active) return { code: 1, lines: [`${p.title} ${args.version} is already signed off (${active.file}).`] };
  try {
    const signed = prepareSignOff({ root, config, state: loaded.items, catalogue, product: p, version: args.version, actor, now: new Date().toISOString(), justification: args.justification });
    commitSignOff(root, signed);
    writeProduct(root, signed.product, loaded.paths.get(p.id));
    return { code: 0, lines: [...signed.warnings, `Signed off: ${signed.file}${signed.record.blockers.length ? ` over ${signed.record.blockers.length} blocker(s)` : ""}`] };
  } catch (e) {
    if (e instanceof GateError) return { code: 1, lines: cliGate(e) };
    throw e;
  }
}
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
  /** Owners only: why the version may go out despite its blockers. */
  justification?: string;
  /** Sign off a version that's already released (released before sign-off records, or after a withdrawal). */
  signOff?: boolean;
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
  if (args.signOff) return signOffCommand(root, args, actor);
  if (!args.correct && args.shipped === undefined) return { code: 1, lines: ['Say what shipped: --shipped REQ-0001,REQ-0002 (or --shipped "" to release a version with nothing in it).'] };
  const loaded = load(root);
  const catalogue = catalogueOf(config, loaded.products);
  const p = productFor(catalogue, args.product);
  if (typeof p === "string") return { code: 1, lines: [p] };
  const now = new Date().toISOString();
  if (args.correct) {
    const locked = lockMessage(root, p, args.version);
    if (locked) return { code: 1, lines: [locked] };
  }
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
    const after = catalogueOf(config, catalogue.products.map((x) => (x.id === p.id ? out.product : x)));
    const next = { ...loaded.items, requirements: out.requirements };
    // A release is signed off in the same step, judged on what ships; nothing is written if it's refused.
    const signed = args.correct ? undefined : prepareSignOff({ root, config, state: next, catalogue: after, product: out.product, version: args.version, actor, now, justification: args.justification });
    if (signed) commitSignOff(root, signed);
    const files = save(root, loaded, next);
    files.push(writeProduct(root, signed?.product ?? out.product, productPath));
    const report = renderReleaseReport(releaseReport(out.requirements, after, out.product, args.version));
    return {
      code: 0,
      lines: [
        ...report.trimEnd().split("\n"),
        "",
        ...(signed?.warnings ?? []),
        `${args.correct ? "Corrected" : "Released"}. Files changed: ${files.join(", ")}`,
        ...(signed ? [`Signed off: ${signed.file}${signed.record.blockers.length ? ` over ${signed.record.blockers.length} blocker(s)` : ""}`] : []),
      ],
    };
  } catch (e) {
    if (e instanceof GateError) return { code: 1, lines: cliGate(e) };
    if (!(e instanceof ReleaseError)) throw e;
    const lines = [e.message];
    if (/already released/.test(e.message)) {
      lines.push(`On the command line: groundwork release ${args.version} --correct --reason "…" [--add ID] [--remove ID] [--move-rest <version>]`);
    }
    return { code: 1, lines };
  }
}

/** `groundwork check release`: the version's blockers. Exits 1 when a planned version has any, for CI. */
export function runCheckCommand(root: string, args: { product?: string; version: string; json?: boolean }): Out {
  const config = readConfig(root);
  const loaded = load(root);
  const p = productFor(catalogueOf(config, loaded.products), args.product);
  if (typeof p === "string") return { code: 1, lines: [p] };
  if (!p.versions.some((v) => v.version === args.version)) return { code: 1, lines: [`${args.version} isn't a version of ${p.title}.`] };
  const out = checkRelease(root, loaded, p, args.version);
  const code = out.status === "planned" && !out.ready ? 1 : 0;
  if (args.json) return { code, lines: JSON.stringify(out, null, 2).split("\n") };
  const name = `${p.title} ${args.version}`;
  if (out.status === "signed-off") return { code, lines: [`${name} is signed off: ${out.record}, by ${out.signedOffBy.name}.`] };
  if (out.status === "released") return { code, lines: [`${name}: ${out.note}. Sign it off with: groundwork release ${args.version} --sign-off`] };
  const n = out.blockers.length;
  return {
    code,
    lines: [
      n ? `${name} isn't ready: ${n} blocker${n === 1 ? "" : "s"}.` : `${name} is ready to release.`,
      ...out.blockers.map((b) => `- ${b.message}`),
      ...out.warnings.map((w) => `warning: ${w}`),
      `CI results read from ${out.results.read.join(" and ")}. ${out.results.hint}`,
    ],
  };
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
