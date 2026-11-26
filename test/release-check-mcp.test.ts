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
  root = mkdtempSync(join(tmpdir(), "groundwork-gate-"));
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


const codeTest = { path: "test/billing.test.ts", name: "billing > REQ-0002 totals match" };
const passingRun = (results = [{ ...codeTest, status: "passed" }]) =>
  write(
    "groundwork/results/ci/20261127T100000Z-abc1234-j1.json",
    JSON.stringify({ id: "run-1", commitSha: "abc1234def", ref: "refs/heads/main", at: "2026-11-27T10:00:00.000Z", source: "ci", defaultBranch: true, totals: { passed: 1, failed: 0, skipped: 0 }, results }),
  );
const records = () => {
  try {
    return readdirSync(join(root, "groundwork/releases")).sort();
  } catch {
    return [];
  }
};
const productText = () => read(`groundwork/products/${readdirSync(join(root, "groundwork/products"))[0]}`);
const withPeople = () => writeConfig(root, { schemaVersion: 2, name: "Acme", productAreas: [], products: [], people: [{ id: "sam", name: "Sam", role: "owner" }, { id: "alex", name: "Alex", role: "editor" }] });

async function ready() {
  const client = await connect();
  await call(client, "add_product_versions", { versions: [{ version: "1.2" }] });
  await call(client, "link_code_tests", { requirementId: "REQ-0002", tests: [codeTest] });
  passingRun();
  return client;
}

describe("releasing through the gate", () => {
  it("release_version releases a ready version and writes its record", async () => {
    const client = await ready();
    const { error, data } = await call(client, "release_version", { version: "1.1", shipped: ["REQ-0002"] });
    expect(error).toBeUndefined();
    expect(data.signOff).toEqual({ file: "groundwork/releases/PRD-0001-1-1-1.json", blockers: [] });
    const rec = JSON.parse(read("groundwork/releases/PRD-0001-1-1-1.json"));
    expect(rec).toMatchObject({ kind: "release", version: "1.1", signedOffBy: { id: "sam", name: "Sam" }, blockers: [] });
    expect(rec.tests.requirements["REQ-0002"].status).toBe("passed");
    expect(productText()).toContain("signOff: groundwork/releases/PRD-0001-1-1-1.json");
  });

  it("release_version refuses a version with blockers and writes nothing", async () => {
    const client = await connect();
    const { error } = await call(client, "release_version", { version: "1.1", shipped: ["REQ-0002"] });
    expect(error).toBe('Acme app 1.1 isn\'t ready: 1 blocker.\n- Requirement "Check totals" has no linked tests\nAn owner can release it anyway with overrideJustification.');
    expect(records()).toEqual([]);
    expect(read(`${REQS}/REQ-0002-totals.md`)).not.toContain("releasedIn");
    expect(productText()).not.toMatch(/version: "1.1"\n\s+status: released/);
  });

  it("an owner releases over blockers with a justification", async () => {
    const client = await connect();
    const { error, data } = await call(client, "release_version", { version: "1.1", shipped: ["REQ-0002"], overrideJustification: "Hotfix; tests follow in 1.2." });
    expect(error).toBeUndefined();
    expect(data.signOff.blockers).toHaveLength(1);
    expect(JSON.parse(read("groundwork/releases/PRD-0001-1-1-1.json")).overrideJustification).toBe("Hotfix; tests follow in 1.2.");
  });

  it("an editor can't release over blockers", async () => {
    withPeople();
    process.env.GROUNDWORK_USER = "alex";
    const { error } = await call(await connect(), "release_version", { version: "1.1", shipped: ["REQ-0002"], overrideJustification: "Please" });
    expect(error).toBe("Only an owner can release over blockers.");
    expect(records()).toEqual([]);
  });

  it("release_version judges what ships, not what moved", async () => {
    const client = await ready();
    write(
      `${REQS}/REQ-0004-later.md`,
      renderItem({ id: "REQ-0004", title: "Later", kind: "solution", story: "The app shall do it later.", status: "approved", stakeholderIds: ["REQ-0001"], product: "PRD-0001", plannedFor: "1.1", ...base }),
    );
    const { error, data } = await call(client, "release_version", { version: "1.1", shipped: ["REQ-0002"], moveTo: "1.2" });
    expect(error).toBeUndefined();
    expect(data.signOff.blockers).toEqual([]);
    expect(JSON.parse(read("groundwork/releases/PRD-0001-1-1-1.json")).requirements.map((r: { id: string }) => r.id)).not.toContain("REQ-0004");
  });

  it("release_version moves a draft planned for the version", async () => {
    const client = await ready();
    write(
      `${REQS}/REQ-0005-draft.md`,
      renderItem({ id: "REQ-0005", title: "Draft", kind: "solution", story: "The app shall maybe.", status: "draft", stakeholderIds: ["REQ-0001"], product: "PRD-0001", plannedFor: "1.1", ...base }),
    );
    expect((await call(client, "release_version", { version: "1.1", shipped: ["REQ-0002"] })).error).toMatch(/REQ-0005/);
    expect((await call(client, "release_version", { version: "1.1", shipped: ["REQ-0002"], moveTo: "1.2" })).error).toBeUndefined();
    expect(read(`${REQS}/REQ-0005-draft.md`)).toContain('plannedFor: "1.2"');
  });

  it("when the record can't be written, nothing is", async () => {
    const client = await ready();
    write("groundwork/releases", "not a folder");
    const { error } = await call(client, "release_version", { version: "1.1", shipped: ["REQ-0002"] });
    expect(error).toBeTruthy();
    expect(read(`${REQS}/REQ-0002-totals.md`)).not.toContain("releasedIn");
  });
});

describe("signing off and withdrawing", () => {
  it("sign_off_release signs off a version released before sign-off records", async () => {
    const client = await connect();
    const { error, data } = await call(client, "sign_off_release", { version: "1.0", overrideJustification: "Released before Groundwork checked tests." });
    expect(error).toBeUndefined();
    expect(data.signOff.file).toBe("groundwork/releases/PRD-0001-1-0-1.json");
    expect(productText()).toContain("signOff: groundwork/releases/PRD-0001-1-0-1.json");
    expect((await call(client, "sign_off_release", { version: "1.0", overrideJustification: "again" })).error).toBe("Acme app 1.0 is already signed off (groundwork/releases/PRD-0001-1-0-1.json).");
  });

  it("withdraw_release then sign_off_release makes record 2 the active one", async () => {
    const client = await connect();
    await call(client, "sign_off_release", { version: "1.0", overrideJustification: "Legacy." });
    const w = await call(client, "withdraw_release", { version: "1.0", reason: "Round amounts shipped in 1.1 instead." });
    expect(w.error).toBeUndefined();
    expect(w.data.next).toContain("sign_off_release");
    await call(client, "sign_off_release", { version: "1.0", overrideJustification: "Legacy, corrected." });
    expect(records()).toEqual(["PRD-0001-1-0-1.json", "PRD-0001-1-0-2.json"]);
    expect(JSON.parse(read("groundwork/releases/PRD-0001-1-0-1.json")).withdrawReason).toBe("Round amounts shipped in 1.1 instead.");
    expect(productText()).toContain("signOff: groundwork/releases/PRD-0001-1-0-2.json");
  });

  it("an editor can't withdraw a sign-off", async () => {
    const client = await connect();
    await call(client, "sign_off_release", { version: "1.0", overrideJustification: "Legacy." });
    withPeople();
    process.env.GROUNDWORK_USER = "alex";
    expect((await call(await connect(), "withdraw_release", { version: "1.0", reason: "x" })).error).toBe("Only an owner can withdraw a sign-off.");
  });

  it("release_requirements on a signed-off version is refused", async () => {
    const client = await connect();
    await call(client, "sign_off_release", { version: "1.0", overrideJustification: "Legacy." });
    const { error } = await call(client, "release_requirements", { version: "1.0", ids: ["REQ-0002"] });
    expect(error).toBe("Acme app 1.0 is signed off (groundwork/releases/PRD-0001-1-0-1.json). Withdraw the sign-off first (withdraw_release), then sign off again.");
  });

  it("correct_release on a signed-off version is refused", async () => {
    const client = await connect();
    await call(client, "sign_off_release", { version: "1.0", overrideJustification: "Legacy." });
    const { error } = await call(client, "correct_release", { version: "1.0", reason: "x", removeShipped: ["REQ-0003"], moveTo: "1.1" });
    expect(error).toMatch(/is signed off .* Withdraw the sign-off first/);
  });

  it("two baseline areas, then sign_off_release, give one record with both", async () => {
    const client = await connect();
    const area = (label: string, key: string) => ({
      version: "0.9",
      approvedBy: "sam",
      area: label,
      stakeholder: [{ key, title: `Need ${label}`, story: `As a clerk I want ${label} so that work gets done.`, acceptanceCriteria: ["Done"] }],
      solution: [{ title: `Do ${label}`, story: `The app shall do ${label}.`, acceptanceCriteria: ["Done"], stakeholderKeys: [key] }],
    });
    await call(client, "add_product_areas", { areas: [{ label: "Payments" }] });
    expect((await call(client, "record_baseline", area("billing", "s1"))).error).toBeUndefined();
    expect((await call(client, "record_baseline", area("Payments", "s2"))).error).toBeUndefined();
    expect(records()).toEqual([]);
    const { error } = await call(client, "sign_off_release", { version: "0.9" });
    expect(error).toBeUndefined();
    const rec = JSON.parse(read("groundwork/releases/PRD-0001-0-9-1.json"));
    expect(rec.kind).toBe("baseline");
    expect(rec.tests).toBeUndefined();
    expect(rec.requirements.filter((r: { kind: string }) => r.kind === "solution")).toHaveLength(2);
  });
});
