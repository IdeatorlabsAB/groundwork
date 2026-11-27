import { riskRegisterRows, inVersion } from "../core/report-rows";
import { caseRef } from "../core/test-links";
import { catalogueOf } from "./catalogue";
import { readConfig, resolveActor } from "./config";
import type { Loaded } from "./files";
import type { Product } from "./products";
import { renderReleaseReport } from "./release";
import { loadResults, resultsFor } from "./results";
import { activeRecord, buildRecord, loadRecords, type SignOffRecord } from "./signoff";

/**
 * What a version's report is built from: its sign-off record when it has one, else the same structure from the current
 * files (a version not released yet, one released before sign-off records, or one whose sign-off was withdrawn).
 */
export type ReportStatus = "signed-off" | "withdrawn" | "legacy" | "not-released";

export function reportView(root: string, loaded: Loaded, product: Product, version: string): { record: SignOffRecord & { file?: string }; status: ReportStatus } {
  const { records } = loadRecords(root);
  const active = activeRecord(records, product.id, version);
  if (active) return { record: active, status: "signed-off" };
  const config = readConfig(root);
  const released = product.versions.find((v) => v.version === version)?.status === "released";
  const withdrawn = records.some((r) => r.product.id === product.id && r.version === version && r.withdrawnAt);
  const record = buildRecord({
    state: loaded.items,
    catalogue: catalogueOf(config, loaded.products),
    config,
    product,
    version,
    tests: resultsFor(loadResults(root, config), product.id, version),
    fetch: { fetched: false, commit: null },
    actor: resolveActor(root, config).id,
    now: new Date().toISOString(),
  });
  return { record, status: released ? (withdrawn ? "withdrawn" : "legacy") : "not-released" };
}

const day = (iso?: string) => (iso ? iso.slice(0, 10) : "an unknown date");

/** The release report as Markdown: what shipped, its tests and their results, the risks and mitigations, and readiness. */
export function renderRecord(record: SignOffRecord, status: ReportStatus): string {
  const base = renderReleaseReport(record.report).trimEnd().split("\n");
  const head: string[] = [];
  if (status === "signed-off") {
    head.push(`Signed off ${day(record.signedAt)} by ${record.signedOffBy.name}.${record.kind === "baseline" ? " A baseline: its tests weren't checked." : ""}`);
    if (record.overrideJustification) head.push(`Released over ${record.blockers.length} blocker${record.blockers.length === 1 ? "" : "s"}. Justification: ${record.overrideJustification}`);
    if (record.tests && !record.tests.fetched) head.push("CI results were read as last fetched; the results branch couldn't be fetched at sign-off.");
  } else if (status === "legacy") head.push("Released before sign-off records: built from the current files, not a frozen record.");
  else if (status === "withdrawn") head.push("Its sign-off was withdrawn: built from the current files, not a frozen record.");
  else head.push("Not signed off: this is how it stands today.");
  const lines = [base[0], "", ...head, ...base.slice(1)];

  lines.push("", "## Tests", "");
  const solutions = record.requirements.filter(inVersion(record.version));
  if (!record.tests) lines.push(record.kind === "baseline" ? "Not checked: a baseline documents what the product already does." : "Not checked.");
  else if (!solutions.length) lines.push("Nothing new in this version.");
  else {
    const runTitle = (tool: string, id?: string) => record.tests!.runs.find((r) => r.tool === tool && r.id === id)?.title;
    for (const r of solutions) {
      const t = record.tests.requirements[r.id];
      lines.push(`- **${r.id}** ${r.title}: ${t ? t.status.replace("-", " ") : "not judged"}`);
      for (const c of t?.codeTests ?? []) lines.push(`  - ${c.path} › ${c.name}: ${c.status.replace("-", " ")}${c.commitSha ? ` (CI on ${c.commitSha.slice(0, 7)})` : ""}`);
      for (const c of t?.cases ?? []) {
        const run = runTitle(c.tool, c.runId);
        lines.push(`  - ${caseRef(c)} ${c.title}: ${c.status.replace("-", " ")}${run ? ` (${run})` : ""}`);
      }
    }
  }

  lines.push("", "## Risks and mitigations", "");
  const risks = riskRegisterRows(record);
  if (!risks.length) lines.push("None tagged for this version.");
  for (const k of risks) {
    lines.push(`- **${k.key}** ${k.title}: ${k.initialLevel} (${k.initial}), residual ${k.residualLevel} (${k.residual}). Mitigated by ${k.mitigations}. Controlled: ${k.controlled}.`);
  }

  lines.push("", "## Readiness", "");
  // Without a record, the blockers are today's, not what was checked when it went out.
  if (status === "legacy" || status === "withdrawn") lines.push(record.blockers.length ? "Not checked at release. As the files are today, these would block it:" : "Not checked at release. As the files are today, nothing would block it.", "");
  if (!record.blockers.length && status !== "legacy" && status !== "withdrawn") lines.push("No blockers.");
  for (const b of record.blockers) lines.push(`- ${b.message}`);
  return lines.join("\n") + "\n";
}
