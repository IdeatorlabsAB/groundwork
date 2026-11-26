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
  root = mkdtempSync(join(tmpdir(), "groundwork-tests-mcp-"));
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


const t1 = { path: "test/billing.test.ts", name: "billing > REQ-0002 totals match lines" };
const qase = { tool: "qase", project: "ACME", id: "12", title: "Totals match lines" };
const rail = { tool: "testrail", id: "12", title: "Totals match lines", url: "https://acme.testrail.io/index.php?/cases/view/12" };
const problems = () => validate(load(root), readConfig(root), { root }).map((p) => `${p.level} ${p.file}: ${p.message}`);

describe("test link tools", () => {
  it("link_code_tests links and skips duplicates", async () => {
    const client = await connect();
    const first = await call(client, "link_code_tests", { requirementId: "REQ-0002", tests: [t1, t1] });
    expect(first.error).toBeUndefined();
    expect(first.data.added).toBe(1);
    expect((await call(client, "link_code_tests", { requirementId: "REQ-0002", tests: [t1] })).data.added).toBe(0);
    const text = read(`${REQS}/REQ-0002-totals.md`);
    expect(text).toContain("path: test/billing.test.ts");
    expect(text).toContain("linkedBy: sam");
  });

  it("link_code_tests refuses a path with ..", async () => {
    const { error } = await call(await connect(), "link_code_tests", { requirementId: "REQ-0002", tests: [{ path: "../x.test.ts", name: "x" }] });
    expect(error).toMatch(/a repo-relative path, without \.\. or a leading \//);
  });

  it("link_code_tests refuses a stakeholder requirement", async () => {
    const { error } = await call(await connect(), "link_code_tests", { requirementId: "REQ-0001", tests: [t1] });
    expect(error).toBe('"Correct invoices" is a stakeholder requirement; link tests to the solution requirements that fulfil it.');
  });

  it("link_test_cases links a TestRail case and a Qase case with the same id", async () => {
    const { error, data } = await call(await connect(), "link_test_cases", { requirementId: "REQ-0002", cases: [qase, rail] });
    expect(error).toBeUndefined();
    expect(data.added).toBe(2);
    expect(data.testCases.map((x: { tool: string }) => x.tool)).toEqual(["qase", "testrail"]);
  });

  it("link_test_cases on a released requirement adds a new case", async () => {
    const { error } = await call(await connect(), "link_test_cases", { requirementId: "REQ-0003", cases: [qase] });
    expect(error).toBeUndefined();
    expect(read(`${REQS}/REQ-0003-shipped.md`)).toContain("tool: qase");
  });

  it("unlink_test_cases refuses a case linked before the release", async () => {
    write(
      `${REQS}/REQ-0003-shipped.md`,
      read(`${REQS}/REQ-0003-shipped.md`).replace("---\n", "---\ntestCases:\n  - { tool: qase, project: ACME, id: \"12\", title: T, linkedAt: 2026-09-01T00:00:00.000Z, linkedBy: sam }\n"),
    );
    const { error } = await call(await connect(), "unlink_test_cases", { requirementId: "REQ-0003", cases: [{ tool: "qase", project: "ACME", id: "12" }] });
    expect(error).toBe('"Round amounts" shipped in 1.0 with qase ACME-12 linked, so it\'s part of that release\'s record and can\'t be unlinked.');
  });

  it("unlink_test_cases removes a case linked after the release", async () => {
    const client = await connect();
    await call(client, "link_test_cases", { requirementId: "REQ-0003", cases: [qase] });
    expect((await call(client, "unlink_test_cases", { requirementId: "REQ-0003", cases: [{ tool: "qase", project: "acme", id: "12" }] })).error).toBeUndefined();
    expect(read(`${REQS}/REQ-0003-shipped.md`)).not.toContain("testCases");
  });

  it("unlink_code_tests refuses a test that isn't linked", async () => {
    const { error } = await call(await connect(), "unlink_code_tests", { requirementId: "REQ-0002", tests: [t1] });
    expect(error).toBe('Not linked to "Check totals": test/billing.test.ts "billing > REQ-0002 totals match lines".');
  });

  it("unlink_test_cases refuses a case that isn't linked", async () => {
    const { error } = await call(await connect(), "unlink_test_cases", { requirementId: "REQ-0002", cases: [{ tool: "testrail", id: "C5" }] });
    expect(error).toBe('Not linked to "Check totals": testrail C5.');
  });

  it("search_items finds a requirement by test case id", async () => {
    const client = await connect();
    await call(client, "link_test_cases", { requirementId: "REQ-0002", cases: [{ tool: "testrail", id: "C777", title: "Totals" }] });
    const { data } = await call(client, "search_items", { query: "C777" });
    expect(data.items.map((x: { id: string }) => x.id)).toEqual(["REQ-0002"]);
  });
});

describe("validate test links", () => {
  const withTests = (file: string, yaml: string) => write(file, read(file).replace("---\n", `---\n${yaml}`));

  it("reports a code test without a name", () => {
    withTests(`${REQS}/REQ-0002-totals.md`, "codeTests:\n  - { path: test/a.test.ts, linkedAt: x, linkedBy: sam }\n");
    expect(problems()).toContain(`error ${REQS}/REQ-0002-totals.md: codeTests: a test needs a path and a name`);
  });

  it("reports a test case without a tool", () => {
    withTests(`${REQS}/REQ-0002-totals.md`, "testCases:\n  - { id: C1, title: T, linkedAt: x, linkedBy: sam }\n");
    expect(problems()).toContain(`error ${REQS}/REQ-0002-totals.md: testCases: a case needs a tool, an id and a title`);
  });

  it("reports tests on a stakeholder requirement", () => {
    withTests(`${REQS}/REQ-0001-need.md`, "testCases:\n  - { tool: qase, id: \"1\", title: T, linkedAt: x, linkedBy: sam }\n");
    expect(problems()).toContain(`error ${REQS}/REQ-0001-need.md: tests on a stakeholder requirement: link them to the solution requirements that fulfil it`);
  });

  it("warns about a code test file that doesn't exist", () => {
    withTests(`${REQS}/REQ-0002-totals.md`, "codeTests:\n  - { path: test/gone.test.ts, name: n, linkedAt: x, linkedBy: sam }\n");
    expect(problems()).toContain(`warning ${REQS}/REQ-0002-totals.md: codeTests: test/gone.test.ts doesn't exist`);
  });

  it("warns about a case linked twice", () => {
    withTests(`${REQS}/REQ-0002-totals.md`, "testCases:\n  - { tool: qase, project: ACME, id: \"12\", title: T, linkedAt: x, linkedBy: sam }\n  - { tool: QASE, project: acme, id: \"12\", title: T, linkedAt: x, linkedBy: sam }\n");
    expect(problems()).toContain(`warning ${REQS}/REQ-0002-totals.md: test case qase ACME-12 is linked twice`);
  });
});

describe("hand-written test links", () => {
  const withTests = (yaml: string) => write(`${REQS}/REQ-0002-totals.md`, read(`${REQS}/REQ-0002-totals.md`).replace("---\n", `---\n${yaml}`));

  it("validate reports a project that isn't text instead of crashing", () => {
    withTests('testCases:\n  - { tool: qase, id: "5", title: T, project: 7, linkedAt: x, linkedBy: sam }\n');
    expect(problems()).toContain(`error ${REQS}/REQ-0002-totals.md: testCases: project must be text, e.g. project: "7"`);
  });

  it("validate asks to quote a numeric case id", () => {
    withTests("testCases:\n  - { tool: qase, id: 12, title: T, linkedAt: x, linkedBy: sam }\n");
    expect(problems()).toContain(`error ${REQS}/REQ-0002-totals.md: testCases: quote the case id, e.g. id: "12"`);
  });

  it("validate reports an empty test entry", () => {
    withTests("codeTests:\n  -\ntestCases:\n  -\n");
    expect(problems()).toEqual(
      expect.arrayContaining([`error ${REQS}/REQ-0002-totals.md: codeTests: a test needs a path and a name`, `error ${REQS}/REQ-0002-totals.md: testCases: a case needs a tool, an id and a title`]),
    );
  });

  it("search_items and link_test_cases don't crash on hand-written entries", async () => {
    withTests('codeTests:\n  -\ntestCases:\n  - { tool: qase, id: 12, title: T, project: 7, linkedAt: x, linkedBy: sam }\n');
    const client = await connect();
    expect((await call(client, "search_items", { query: "totals" })).error).toBeUndefined();
    expect((await call(client, "link_test_cases", { requirementId: "REQ-0002", cases: [qase] })).error).toBeUndefined();
  });
});
