import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/mcp/server";
import { readConfig, writeConfig } from "../src/store/config";
import { load, renderItem } from "../src/store/files";
import { validate } from "../src/store/validate";
import { writeProduct } from "../src/store/products";

let root: string;
const REQS = "groundwork/requirements";

const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const base = { findingIds: [], acceptanceCriteria: ["Works"], createdAt: "2026-11-01T00:00:00.000Z" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "groundwork-polish-"));
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


const problems = () => validate(load(root), readConfig(root), { root }).map((p) => `${p.level} ${p.file}: ${p.message}`);
const withFront = (rel: string, yaml: string) => write(rel, read(rel).replace("---\n", `---\n${yaml}`));

describe("risks, validation and ids", () => {
  it("validate reports a mitigation the requirement doesn't list back", () => {
    write("groundwork/risks/RSK-0001-a.md", renderItem({ id: "RSK-0001", title: "A", hazard: "h", harm: "x", probability: 2, severity: 2, mitigationIds: ["REQ-0002"], versions: [], product: "PRD-0001", createdAt: "x" }));
    expect(problems()).toContain("error groundwork/risks/RSK-0001-a.md: mitigationIds: REQ-0002 doesn't list RSK-0001 in its riskIds");
  });

  it("validate warns about a risk without a product", () => {
    write("groundwork/risks/RSK-0001-a.md", renderItem({ id: "RSK-0001", title: "A", hazard: "h", harm: "x", probability: 2, severity: 2, mitigationIds: [], versions: [], createdAt: "x" }));
    expect(problems()).toContain("warning groundwork/risks/RSK-0001-a.md: no product: set product, so its versions can be checked");
  });

  it("validate warns about a test link without linkedAt, and reports tests that aren't a list", () => {
    withFront(`${REQS}/REQ-0002-totals.md`, "codeTests:\n  - { path: test/a.test.ts, name: n, linkedBy: sam }\ntestCases: nope\n");
    const p = problems();
    expect(p).toContain(`warning ${REQS}/REQ-0002-totals.md: codeTests: test/a.test.ts "n" has no linkedAt, so it can't be told apart from what shipped`);
    expect(p).toContain(`error ${REQS}/REQ-0002-totals.md: testCases must be a list`);
  });

  it("add_risks in a folder with products in config.yml says to migrate", async () => {
    writeConfig(root, { schemaVersion: 1, name: "Acme", productAreas: [], products: ["Acme app"], people: [{ id: "sam", name: "Sam", role: "owner" }] });
    rmSync(join(root, "groundwork/products"), { recursive: true, force: true });
    const { error } = await call(await connect(), "add_risks", { risks: [{ title: "A", probability: 1, severity: 1 }] });
    expect(error).toBe('Products are still in config.yml. Run "groundwork migrate" first.');
  });

  it("unlinking the last code test clears the field, as with cases", async () => {
    const client = await connect();
    const t = { path: "test/a.test.ts", name: "a" };
    await call(client, "link_code_tests", { requirementId: "REQ-0002", tests: [t] });
    await call(client, "unlink_code_tests", { requirementId: "REQ-0002", tests: [t] });
    expect(read(`${REQS}/REQ-0002-totals.md`)).not.toContain("codeTests");
  });

  it("unlink_code_tests refuses a test linked before the release", async () => {
    withFront(`${REQS}/REQ-0003-shipped.md`, "codeTests:\n  - { path: test/a.test.ts, name: a, linkedAt: 2026-09-01T00:00:00.000Z, linkedBy: sam }\n");
    const { error } = await call(await connect(), "unlink_code_tests", { requirementId: "REQ-0003", tests: [{ path: "test/a.test.ts", name: "a" }] });
    expect(error).toBe('"Round amounts" shipped in 1.0 with test/a.test.ts "a" linked, so it\'s part of that release\'s record and can\'t be unlinked.');
  });

  it("requirements added together get ids in the order given", async () => {
    const { data } = await call(await connect(), "add_requirements", {
      requirements: ["One", "Two", "Three"].map((title) => ({ kind: "solution", title, story: `The app shall do ${title}.`, acceptanceCriteria: ["Done"], stakeholderIds: ["REQ-0001"], origin: "customer-need" })),
    });
    expect(data.created.map((x: { id: string; title: string }) => `${x.id} ${x.title}`)).toEqual(["REQ-0004 One", "REQ-0005 Two", "REQ-0006 Three"]);
  });

  it("search_items pages past the first results with offset", async () => {
    const client = await connect();
    const all = (await call(client, "search_items", { kind: "requirement", limit: 100 })).data;
    const page2 = (await call(client, "search_items", { kind: "requirement", limit: 1, offset: 1 })).data;
    expect(page2.items.map((x: { id: string }) => x.id)).toEqual([all.items[1].id]);
    expect(page2).toMatchObject({ total: all.total, shown: 1, offset: 1 });
  });
});

describe("the CLI's item labels", () => {
  it("a risk shows its level and residual level", async () => {
    const { itemTags } = await import("../src/core/labels");
    const { defaultMatrix } = await import("../src/core/risk");
    expect(itemTags("risk", { id: "RSK-0001", title: "A", probability: 5, severity: 5, residualProbability: 1, residualSeverity: 2 } as never, defaultMatrix())).toEqual(["high", "residual low"]);
    expect(itemTags("requirement", { id: "REQ-0001", title: "A", kind: "solution", status: "approved" } as never, defaultMatrix())).toEqual(["solution", "approved"]);
  });
});

describe("after the review", () => {
  it("requirements with and without findings keep the order given", async () => {
    const req = (title: string, findingIds: string[]) => ({ kind: "solution", title, story: `The app shall do ${title}.`, acceptanceCriteria: ["Done"], stakeholderIds: ["REQ-0001"], findingIds });
    write("groundwork/findings/FND-0001-f.md", renderItem({ id: "FND-0001", title: "F", statement: "Users want it.", insightIds: [], createdAt: "x" }));
    const out = await call(await connect(), "add_requirements", { requirements: [req("A", ["FND-0001"]), req("B", [])] });
    expect(out.error).toBeUndefined();
    const { data } = out;
    expect(data.created.map((x: { id: string; title: string }) => `${x.id} ${x.title}`)).toEqual(["REQ-0004 A", "REQ-0005 B"]);
  });

  it("a pre-0.6 folder's message fits any tool", async () => {
    writeConfig(root, { schemaVersion: 1, name: "Acme", productAreas: [], products: ["Acme app"], people: [{ id: "sam", name: "Sam", role: "owner" }] });
    rmSync(join(root, "groundwork/products"), { recursive: true, force: true });
    const { error } = await call(await connect(), "release_version", { version: "1.0", shipped: [] });
    expect(error).toBe('Products are still in config.yml. Run "groundwork migrate" first.');
  });

  it("PR comment links survive a stray % in a file name", async () => {
    const { prReport } = await import("../src/core/pr-report");
    const { defaultMatrix } = await import("../src/core/risk");
    const items = load(root).items;
    const files = new Map([["REQ-0002", "groundwork/requirements/REQ-0002 100%.md"]]);
    const md = prReport({ keys: ["REQ-0002"], changedPaths: [], items, matrix: defaultMatrix(), files, linkBase: "https://github.com/o/r/blob/abc/" }).markdown;
    expect(md).toContain("(https://github.com/o/r/blob/abc/groundwork/requirements/REQ-0002%20100%25.md)");
  });
});
