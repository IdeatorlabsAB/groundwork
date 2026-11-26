// Ported from centropic-prototype src/lib/ci/trailer.ts and pr-report.ts. Keep in step with them.
import { refPath, touches } from "./code-refs";
import type { Collections } from "./collections";
import type { CodeTestResult } from "./junit";
import { isRunOf } from "./match-tests";
import { kindOf } from "./requirements";
import { initialLevel, MITIGATION_OK } from "./risk";
import type { Requirement, Risk, RiskMatrix } from "./types";

/**
 * What CI says about a pull request: the requirements and risks it names (in its Groundwork: trailer) or touches
 * (through their codeRefs), and the traceability gaps among them. Pure: the Action posts the Markdown.
 */

const ITEM_ID = /^(INS|HYP|EXP|FND|REQ|RSK|PRD)-\d{4,}$/;

/**
 * The ids a PR or commit names in its `Groundwork:` trailer, e.g. "Groundwork: REQ-0042, RSK-0007". Read from every
 * given text, in order of first appearance, uppercased and without duplicates. Ids anywhere else don't count.
 */
export function groundworkKeys(...texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const line of (text ?? "").split(/\r?\n/)) {
      const m = /^\s*groundwork:\s*(.+)$/i.exec(line);
      if (!m) continue;
      for (const word of m[1].split(/[\s,;]+/)) {
        const key = word.trim().toUpperCase();
        if (ITEM_ID.test(key) && !out.includes(key)) out.push(key);
      }
    }
  }
  return out;
}

export interface ItemRef {
  key: string;
  kind: "requirement" | "risk";
  title: string;
  /** The item's file in the repository. */
  file?: string;
  /** The file on GitHub, when a link base was given. */
  link?: string;
}

export type Gap =
  | { type: "untested-requirement"; key: string; title: string }
  | { type: "unnamed-approved-change"; key: string; title: string; paths: string[] }
  | { type: "unmitigated-high-risk"; key: string; title: string }
  /** Only with this PR's test results: linked code tests that failed in them. Entries are "path › name". */
  | { type: "failed-code-test"; key: string; title: string; tests: string[] }
  /** Only with this PR's test results: linked code tests missing from them, or skipped. */
  | { type: "code-tests-not-run"; key: string; title: string; tests: string[] };

export interface PrReport {
  named: ItemRef[];
  touched: ItemRef[];
  unknownKeys: string[];
  gaps: Gap[];
  markdown: string;
}

export const COMMENT_MARKER = "<!-- groundwork -->";

/** `results`: this PR's own test results, when CI has them. Without them, nothing is said about test outcomes. */
export function prReport(input: {
  keys: string[];
  changedPaths: string[];
  items: Collections;
  matrix: RiskMatrix;
  /** Item id -> its file, relative to the repository root. */
  files: Map<string, string>;
  /** e.g. https://github.com/acme/app/blob/<sha>/ */
  linkBase?: string;
  results?: CodeTestResult[];
  /** Said in the comment: e.g. a JUnit report that couldn't be read, or files in groundwork/ that couldn't. */
  notes?: string[];
}): PrReport {
  const { keys, changedPaths, items, matrix, files, linkBase, results, notes = [] } = input;
  const reqs = items.requirements.filter((r) => r.status !== "obsolete");
  const ref = (kind: ItemRef["kind"], x: Requirement | Risk): ItemRef => {
    const file = files.get(x.id);
    return { key: x.id, kind, title: x.title, ...(file ? { file } : {}), ...(file && linkBase ? { link: `${linkBase}${file}` } : {}) };
  };

  const named: ItemRef[] = [];
  const namedReqs: Requirement[] = [];
  const namedRisks: Risk[] = [];
  const unknownKeys: string[] = [];
  for (const key of keys) {
    const r = reqs.find((x) => x.id === key);
    const k = r ? undefined : items.risks.find((x) => x.id === key);
    if (r) {
      named.push(ref("requirement", r));
      namedReqs.push(r);
    } else if (k) {
      named.push(ref("risk", k));
      namedRisks.push(k);
    } else unknownKeys.push(key);
  }

  const hits = (refs: string[] | undefined) => changedPaths.filter((p) => (refs ?? []).some((c) => touches(c, p)));
  const touchedReqs = reqs.filter((r) => hits(r.codeRefs).length);
  const touchedRisks = items.risks.filter((r) => hits(r.codeRefs).length);
  const touched = [...touchedReqs.map((r) => ref("requirement", r)), ...touchedRisks.map((r) => ref("risk", r))];

  const gaps: Gap[] = [];
  for (const r of namedReqs) {
    if (kindOf(r) === "solution" && !r.codeTests?.length && !r.testCases?.length) gaps.push({ type: "untested-requirement", key: r.id, title: r.title });
  }
  if (results) {
    for (const r of namedReqs) {
      if (kindOf(r) !== "solution" || !r.codeTests?.length) continue;
      const outcome = (t: { path: string; name: string }) => results.findLast((x) => isRunOf(t, x))?.status;
      const label = (t: { path: string; name: string }) => `${t.path} › ${t.name}`;
      const failed = r.codeTests.filter((t) => outcome(t) === "failed").map(label);
      // Only files these results cover: another CI job may run the rest.
      const covered = new Set(results.map((x) => x.path));
      const notRun = r.codeTests.filter((t) => covered.has(refPath(t.path)) && (!outcome(t) || outcome(t) === "skipped")).map(label);
      if (failed.length) gaps.push({ type: "failed-code-test", key: r.id, title: r.title, tests: failed });
      if (notRun.length) gaps.push({ type: "code-tests-not-run", key: r.id, title: r.title, tests: notRun });
    }
  }
  for (const r of touchedReqs) {
    if (MITIGATION_OK.includes(r.status) && !namedReqs.includes(r)) gaps.push({ type: "unnamed-approved-change", key: r.id, title: r.title, paths: hits(r.codeRefs) });
  }
  for (const r of new Set([...namedRisks, ...touchedRisks])) {
    if (initialLevel(matrix, r) === "high" && !r.mitigationIds.length) gaps.push({ type: "unmitigated-high-risk", key: r.id, title: r.title });
  }

  return { named, touched, unknownKeys, gaps, markdown: markdown(named, touched, unknownKeys, gaps, notes) };
}

/**
 * Text from the repository's files, made inert in Markdown. In local mode a pull request's own files supply the
 * titles, so a title mustn't add links, images or table cells to the comment.
 */
const text = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .replace(/([\\`*_[\]()!|<>#])/g, "\\$1")
    // A zero-width space after @ stops GitHub turning it into a mention, and in :// stops a bare URL becoming a link.
    .replace(/@/g, "@\u200b")
    .replace(/:\/\//g, ":\u200b//");

const GAP_TEXT: Record<Gap["type"], (g: Gap) => string> = {
  "untested-requirement": (g) => `**${g.key}** ${text(g.title)}: no tests are linked. Link the tests that verify it.`,
  "unnamed-approved-change": (g) =>
    `**${g.key}** ${text(g.title)}: approved, and its code changed (${(g as Extract<Gap, { paths: string[] }>).paths.map(code).join(", ")}), but this PR doesn't name it. Add it to the \`Groundwork:\` trailer if this changes it.`,
  "unmitigated-high-risk": (g) => `**${g.key}** ${text(g.title)}: a high risk with no mitigating requirement.`,
  "failed-code-test": (g) => `**${g.key}** ${text(g.title)}: tests failed in this PR: ${testList(g)}.`,
  "code-tests-not-run": (g) => `**${g.key}** ${text(g.title)}: tests didn't run in this PR: ${testList(g)}.`,
};

/** Inline code that can't be broken out of with a backtick. */
const code = (s: string) => `\`${s.replace(/`/g, "'").replace(/\s+/g, " ")}\``;
const testList = (g: Gap) => ((g as Extract<Gap, { tests: string[] }>).tests ?? []).map(code).join(", ");

function markdown(named: ItemRef[], touched: ItemRef[], unknownKeys: string[], gaps: Gap[], notes: string[]): string {
  const lines = [COMMENT_MARKER, "## Groundwork", ""];
  const rows = [...named.map((x) => ({ ...x, how: "named" })), ...touched.filter((t) => !named.some((n) => n.key === t.key)).map((x) => ({ ...x, how: "code changed" }))];
  if (rows.length) {
    lines.push("### Linked", "", "| Key | Item | Why |", "| --- | --- | --- |");
    for (const r of rows) {
      const item = r.link ? `[${text(r.title)}](${encodeURI(r.link)})` : r.file ? `${text(r.title)} (${code(r.file)})` : text(r.title);
      lines.push(`| ${r.key} | ${item} | ${r.how} |`);
    }
  } else {
    lines.push("This PR doesn't name or touch any requirement or risk. Name them with a `Groundwork: REQ-0042` trailer in the description.");
  }
  if (unknownKeys.length) lines.push("", `Not found in groundwork/: ${unknownKeys.join(", ")}. Only requirement and risk ids count.`);
  lines.push("", "### Gaps", "");
  if (gaps.length) for (const g of gaps) lines.push(`- ${GAP_TEXT[g.type](g)}`);
  else lines.push("No gaps found.");
  if (notes.length) {
    lines.push("", "### Notes", "");
    for (const n of notes) lines.push(`- ${text(n)}`);
  }
  return lines.join("\n");
}
