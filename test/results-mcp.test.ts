import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/mcp/server";
import { writeConfig } from "../src/store/config";
import { renderItem } from "../src/store/files";
import { writeProduct } from "../src/store/products";

let root: string;
const REQS = "groundwork/requirements";

const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const base = { findingIds: [], acceptanceCriteria: ["Works"], createdAt: "2026-11-01T00:00:00.000Z" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "groundwork-results-mcp-"));
  process.env.GROUNDWORK_USER = "sam";
  writeConfig(root, { schemaVersion: 2, name: "Acme", productAreas: [], products: [], people: [{ id: "sam", name: "Sam", role: "owner" }] });
  writeProduct(root, {
    id: "PRD-0001",
    title: "Acme app",
    areas: [{ id: "billing", label: "Billing" }],
    versions: [
      { version: "1.0", status: "released", releasedAt: "2026-10-01T00:00:00.000Z", releasedBy: "sam" },
      { version: "1.1", status: "planned" },
    ],
    createdAt: "2026-11-01T00:00:00.000Z",
  } as never);
  write(`${REQS}/REQ-0001-need.md`, renderItem({ id: "REQ-0001", title: "Correct invoices", kind: "stakeholder", story: "As a customer I want correct invoices so that I pay the right amount.", status: "approved", ...base }));
  write(
    `${REQS}/REQ-0002-totals.md`,
    renderItem({ id: "REQ-0002", title: "Check totals", kind: "solution", story: "The invoice shall show totals that match its lines.", status: "approved", stakeholderIds: ["REQ-0001"], product: "PRD-0001", plannedFor: "1.1", codeRefs: ["src/billing/invoice.ts#total"], ...base }),
  );
  write(
    `${REQS}/REQ-0003-shipped.md`,
    renderItem({ id: "REQ-0003", title: "Round amounts", kind: "solution", story: "The invoice shall round amounts to cents.", status: "approved", stakeholderIds: ["REQ-0001"], product: "PRD-0001", plannedFor: "1.0", releasedIn: "1.0", releasedAt: "2026-10-01T00:00:00.000Z", releasedBy: "sam", ...base }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.GROUNDWORK_USER;
});

async function connect() {
  const server = buildServer({ root });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = res.content[0].text;
  return { error: res.isError ? text : undefined, data: res.isError ? undefined : JSON.parse(text) };
}

const wrongTotal = { title: "Invoice total wrong", hazard: "Totals are computed from stale lines.", harm: "Customers are overcharged.", probability: 5, severity: 5 };
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const riskFile = () => `groundwork/risks/${readdirSync(join(root, "groundwork/risks"))[0]}`;

async function withRisk(client: Client, extra: Record<string, unknown> = {}) {
  const r = await call(client, "add_risks", { risks: [{ ...wrongTotal, ...extra }] });
  expect(r.error).toBeUndefined();
  return r.data.created[0].id as string;
}


const caseC101 = { tool: "testrail", id: "C101", title: "Totals match" };
const codeTest = { path: "test/billing.test.ts", name: "billing > REQ-0002 totals match" };
const runInput = { tool: "testrail", project: "", id: "R3", title: "1.1 regression" };
const toolDir = () => join(root, "groundwork/results/tools");
const writeCi = (name: string, over: Record<string, unknown> = {}) =>
  write(
    `groundwork/results/ci/${name}.json`,
    JSON.stringify({
      id: name,
      commitSha: "abc1234def",
      ref: "refs/heads/main",
      at: "2026-11-27T10:00:00.000Z",
      source: "ci",
      defaultBranch: true,
      totals: { passed: 1, failed: 0, skipped: 0 },
      results: [{ ...codeTest, status: "passed" }],
      ...over,
    }),
  );

async function linked() {
  const client = await connect();
  await call(client, "link_test_cases", { requirementId: "REQ-0002", cases: [caseC101] });
  await call(client, "link_code_tests", { requirementId: "REQ-0002", tests: [codeTest] });
  return client;
}

describe("record_test_results", () => {
  it("record_test_results writes a TestRail run for a planned version", async () => {
    const client = await linked();
    const { error, data } = await call(client, "record_test_results", { version: "1.1", run: runInput, results: [{ id: "C101", status: "passed", endTime: "2026-11-27T10:00:00Z" }] });
    expect(error).toBeUndefined();
    expect(data.recorded.file).toMatch(/^groundwork\/results\/tools\/testrail-_-r3-[0-9a-f]{8}\.json$/);
    const stored = JSON.parse(read(data.recorded.file));
    expect(stored).toMatchObject({ source: "test-tool", tool: "testrail", id: "R3", product: "PRD-0001", version: "1.1", recordedBy: "sam" });
    expect(data.tests["REQ-0002"].cases[0]).toMatchObject({ id: "C101", status: "passed" });
  });

  it("recording the same run again replaces the file", async () => {
    const client = await linked();
    await call(client, "record_test_results", { version: "1.1", run: runInput, results: [] });
    await call(client, "record_test_results", { version: "1.1", run: { ...runInput, title: "renamed" }, results: [] });
    expect(readdirSync(toolDir())).toHaveLength(1);
  });

  it("record_test_results refuses a released version", async () => {
    const { error } = await call(await connect(), "record_test_results", { version: "1.0", run: runInput, results: [] });
    expect(error).toBe("Acme app 1.0 is released, so its test results can't change.");
  });

  it("record_test_results refuses an unknown version", async () => {
    const { error } = await call(await connect(), "record_test_results", { version: "9.9", run: runInput, results: [] });
    expect(error).toBe('"9.9" isn\'t a version of Acme app. Versions: 1.0, 1.1.');
  });

  it("record_test_results needs endTime for finished results", async () => {
    const { error } = await call(await connect(), "record_test_results", { version: "1.1", run: runInput, results: [{ id: "C101", status: "passed" }] });
    expect(error).toContain("endTime");
  });
});

describe("test status on requirements", () => {
  it("get_item shows a requirement's test status from CI and tool runs", async () => {
    const client = await linked();
    writeCi("20261127T100000Z-abc1234-j1");
    await call(client, "record_test_results", { version: "1.1", run: runInput, results: [{ id: "C101", status: "failed", endTime: "2026-11-27T10:00:00Z" }] });
    let { data } = await call(client, "get_item", { id: "REQ-0002" });
    expect(data.tests.status).toBe("failed");
    expect(data.tests.version).toBe("1.1");
    expect(data.tests.read).toEqual(["working tree"]);
    await call(client, "record_test_results", { version: "1.1", run: { ...runInput, id: "R4" }, results: [{ id: "C101", status: "passed", endTime: "2026-11-28T10:00:00Z" }] });
    ({ data } = await call(client, "get_item", { id: "REQ-0002" }));
    expect(data.tests.status).toBe("passed");
  });

  it("get_item ignores a run that isn't CI on the default branch", async () => {
    const client = await linked();
    writeCi("20261127T100000Z-abc1234-j1", { defaultBranch: false });
    writeCi("20261127T110000Z-abc1234-j2", { source: "local" });
    const { data } = await call(client, "get_item", { id: "REQ-0002" });
    expect(data.tests.codeTests[0].status).toBe("not-run");
  });

  it("get_item has no tests section for a requirement without tests", async () => {
    const { data } = await call(await connect(), "get_item", { id: "REQ-0002" });
    expect(data.tests).toBeUndefined();
  });
});
