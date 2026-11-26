// Ported from centropic-prototype src/lib/ci/junit.ts. Keep in step with it.
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { refPath } from "./code-refs";

/**
 * JUnit XML, as most test runners write it (vitest, jest-junit, pytest, Go's gotestsum, Maven Surefire), read into
 * one result per test case. Suites may nest; they're flattened.
 */

export type CodeTestStatus = "passed" | "failed" | "skipped";

export interface CodeTestResult {
  /** The test file, repo-relative: the case's `file` attribute, or its `classname` when there is none. */
  path: string;
  name: string;
  status: CodeTestStatus;
  durationMs?: number;
}

export class JunitError extends Error {}

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => name === "testsuite" || name === "testcase",
});

export function parseJunit(xml: string): CodeTestResult[] {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new JunitError(`The JUnit report isn't valid XML: ${valid.err.msg} (line ${valid.err.line}).`);
  const doc = parser.parse(xml) as Node;
  const root = (doc.testsuites as Node | undefined) ?? (doc.testsuite ? { testsuite: doc.testsuite } : undefined);
  if (!root) throw new JunitError("The JUnit report has no <testsuites> or <testsuite> element.");
  const out: CodeTestResult[] = [];
  walk(root, out);
  return out;
}

function walk(suite: Node, out: CodeTestResult[]) {
  for (const tc of (suite.testcase as Node[] | undefined) ?? []) {
    const name = String(tc["@name"] ?? "").trim();
    const path = refPath(String(tc["@file"] ?? tc["@classname"] ?? ""));
    if (!name) continue;
    const status: CodeTestStatus = "failure" in tc || "error" in tc ? "failed" : "skipped" in tc ? "skipped" : "passed";
    const seconds = Number(tc["@time"]);
    out.push({ path, name, status, ...(Number.isFinite(seconds) ? { durationMs: Math.round(seconds * 1000) } : {}) });
  }
  for (const child of (suite.testsuite as Node[] | undefined) ?? []) walk(child, out);
}
