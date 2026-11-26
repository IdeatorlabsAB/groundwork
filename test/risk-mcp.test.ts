import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  root = mkdtempSync(join(tmpdir(), "groundwork-risk-mcp-"));
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

describe("risk tools", () => {
  it("get_workspace returns the 5×5 default riskMatrix", async () => {
    const { data } = await call(await connect(), "get_workspace");
    expect(data.riskMatrix.size).toBe(5);
    expect(data.riskMatrix.cells[4][4]).toBe("high");
    expect(data.counts.risk).toBe(0);
  });

  it("add_risks creates RSK-0001 with level high for p5 s5", async () => {
    const { data } = await call(await connect(), "add_risks", { risks: [wrongTotal] });
    expect(data.created[0]).toMatchObject({ kind: "risk", id: "RSK-0001", level: "high" });
    expect(riskFile()).toBe("groundwork/risks/RSK-0001-invoice-total-wrong.md");
    expect(read(riskFile())).toContain("product: PRD-0001");
    expect(read(riskFile())).toContain("owner: sam");
  });

  it("add_risks refuses probability 6", async () => {
    const { error } = await call(await connect(), "add_risks", { risks: [{ ...wrongTotal, probability: 6 }] });
    expect(error).toBe("probability must be a whole number from 1 to 5 on this workspace's 5×5 risk matrix (got 6).");
  });

  it("add_risks refuses a released version and accepts a planned one", async () => {
    const client = await connect();
    expect((await call(client, "add_risks", { risks: [{ ...wrongTotal, versions: ["1.0"] }] })).error).toBe('"1.0" is released, so a risk can\'t be added to it or removed from it.');
    expect((await call(client, "add_risks", { risks: [{ ...wrongTotal, versions: ["9.9"] }] })).error).toBe('"9.9" isn\'t a version of Acme app. Versions: 1.0, 1.1.');
    expect((await call(client, "add_risks", { risks: [{ ...wrongTotal, versions: ["1.1"] }] })).error).toBeUndefined();
  });

  it("link_items risk -> requirement links both sides", async () => {
    const client = await connect();
    const id = await withRisk(client);
    const { error } = await call(client, "link_items", { id, linkTo: ["REQ-0002"] });
    expect(error).toBeUndefined();
    expect(read(riskFile())).toMatch(/mitigationIds:\n  - REQ-0002/);
    expect(read(`${REQS}/REQ-0002-totals.md`)).toMatch(/riskIds:\n  - RSK-0001/);
  });

  it("link_items risk -> released requirement succeeds", async () => {
    const client = await connect();
    const id = await withRisk(client);
    expect((await call(client, "link_items", { id, linkTo: ["REQ-0003"] })).error).toBeUndefined();
    expect(read(`${REQS}/REQ-0003-shipped.md`)).toMatch(/riskIds:\n  - RSK-0001/);
  });

  it("link_items requirement -> risk gives the link-the-other-way error", async () => {
    const client = await connect();
    const id = await withRisk(client);
    expect((await call(client, "link_items", { id: "REQ-0002", linkTo: [id] })).error).toBe("Link the other way: link_items from the risk to the requirement.");
  });

  it("update_item changes residual scores and get_item shows mitigated true", async () => {
    const client = await connect();
    const id = await withRisk(client);
    await call(client, "link_items", { id, linkTo: ["REQ-0002"] });
    expect((await call(client, "update_item", { id, patch: { residualProbability: 2, residualSeverity: 2 } })).error).toBeUndefined();
    const { data } = await call(client, "get_item", { id });
    expect(data.item).toMatchObject({ level: "high", residualLevel: "low" });
    expect(data.mitigated).toBe(true);
    expect(data.mitigatedBy.map((x: { id: string }) => x.id)).toEqual(["REQ-0002"]);
  });

  it("update_item refuses a score outside the matrix", async () => {
    const client = await connect();
    const id = await withRisk(client);
    expect((await call(client, "update_item", { id, patch: { residualSeverity: 7 } })).error).toBe(
      "residualSeverity must be a whole number from 1 to 5 on this workspace's 5×5 risk matrix (got 7).",
    );
  });

  it("update_item refuses removing a released version", async () => {
    const client = await connect();
    const id = await withRisk(client, { versions: ["1.1"] });
    // Tag it for 1.0 by hand, as a baseline would.
    writeFileSync(join(root, riskFile()), read(riskFile()).replace("versions:\n  - \"1.1\"", 'versions:\n  - "1.0"\n  - "1.1"'));
    expect((await call(client, "update_item", { id, patch: { versions: ["1.1"] } })).error).toBe('"1.0" is released, so a risk can\'t be added to it or removed from it.');
    expect((await call(client, "update_item", { id, patch: { versions: ["1.0"] } })).error).toBeUndefined();
  });

  it("update_item refuses changing the product of a risk tagged for versions", async () => {
    const client = await connect();
    await call(client, "add_products", { products: ["Acme mobile"] });
    const id = await withRisk(client, { versions: ["1.1"], product: "PRD-0001" });
    expect((await call(client, "update_item", { id, patch: { product: "Acme mobile" } })).error).toBe('"Invoice total wrong" is tagged for versions of Acme app, so its product can\'t change.');
  });

  it("delete_item on a risk clears the requirement's riskIds", async () => {
    const client = await connect();
    const id = await withRisk(client);
    await call(client, "link_items", { id, linkTo: ["REQ-0002"] });
    expect((await call(client, "delete_item", { id })).error).toBeUndefined();
    expect(read(`${REQS}/REQ-0002-totals.md`)).not.toContain("RSK-0001");
  });

  it("search_items kind risk finds by hazard text", async () => {
    const client = await connect();
    await withRisk(client);
    const { data } = await call(client, "search_items", { kind: "risk", query: "stale lines" });
    expect(data.items).toEqual([expect.objectContaining({ id: "RSK-0001", level: "high" })]);
  });

  it("trace_code returns the risk and requirement whose codeRefs touch src/billing", async () => {
    const client = await connect();
    await withRisk(client, { codeRefs: ["src/billing/invoice.ts#total"] });
    const { data } = await call(client, "trace_code", { paths: ["src/billing", "src/other"] });
    expect(data.paths[0].risks.map((x: { id: string }) => x.id)).toEqual(["RSK-0001"]);
    expect(data.paths[0].requirements.map((x: { id: string }) => x.id)).toEqual(["REQ-0002"]);
    expect(data.paths[1]).toEqual({ path: "src/other", requirements: [], risks: [] });
  });
});

describe("record_baseline with risks", () => {
  const args = (risk: Record<string, unknown>) => ({
    version: "0.9",
    approvedBy: "sam",
    area: "billing",
    stakeholder: [{ key: "s1", title: "Pay invoices", story: "As a customer I want to pay invoices so that my account is settled.", acceptanceCriteria: ["Paid"] }],
    solution: [{ key: "pay", title: "Card payments", story: "The billing page shall take card payments.", acceptanceCriteria: ["Taken"], stakeholderKeys: ["s1"] }],
    risks: [{ title: "Card charged twice", hazard: "A retry submits the payment again.", harm: "Customers pay twice.", probability: 3, severity: 4, category: "domain", domain: "financial", mitigationKeys: ["pay"], ...risk }],
  });

  it("records a baseline risk with its control", async () => {
    const client = await connect();
    const { error, data } = await call(client, "record_baseline", args({}));
    expect(error).toBeUndefined();
    expect(data.created.risks).toEqual(["RSK-0001"]);
    const text = read(riskFile());
    expect(text).toContain("origin: existing-product");
    expect(text).toMatch(/versions:\n  - "0.9"/);
    expect(text).toMatch(/mitigationIds:\n  - REQ-\d{4}/);
  });

  it("refuses a baseline risk scored outside the matrix", async () => {
    const { error } = await call(await connect(), "record_baseline", args({ severity: 9 }));
    expect(error).toBe("severity must be a whole number from 1 to 5 on this workspace's 5×5 risk matrix (got 9).");
  });

  it("refuses a baseline risk mitigated by an insight", async () => {
    write("groundwork/insights/INS-0001-a.md", renderItem({ id: "INS-0001", title: "A", quote: "q", source: "interview", persona: "P", tags: [], sentiment: "neutral", createdAt: "x" }));
    const { error } = await call(await connect(), "record_baseline", args({ mitigationKeys: [], mitigationIds: ["INS-0001"] }));
    expect(error).toBe("mitigationIds: INS-0001 is an insight, not a requirement.");
  });
});
