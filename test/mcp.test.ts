import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/mcp/server";
import { readConfig, writeConfig } from "../src/store/config";
import { load } from "../src/store/files";
import { validate } from "../src/store/validate";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "groundwork-"));
  process.env.GROUNDWORK_USER = "sam";
  writeConfig(root, {
    schemaVersion: 1,
    name: "Acme",
    productAreas: [{ id: "onboarding", label: "Onboarding" }],
    products: ["Acme app"],
    people: [
      { id: "sam", name: "Sam", role: "owner" },
      { id: "alex", name: "Alex", role: "editor" },
    ],
  });
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

const files = (dir: string) => readdirSync(join(root, "groundwork", dir)).sort();

/** Insight -> hypothesis -> experiment (run, validated) -> finding -> requirement. Returns their ids. */
async function chain(c: Client) {
  const ins = await call(c, "add_insights", {
    insights: [
      { title: "Setup takes too long", quote: "I gave up on the import after twenty minutes.", source: "interview", persona: "Ops lead", productArea: "Onboarding" },
      { title: "Import errors are unclear", quote: "It just said 'error 4'.", source: "support", persona: "Ops lead" },
    ],
  });
  const [i1, i2] = ins.data.created.map((x: { id: string }) => x.id);
  const hyp = await call(c, "add_hypotheses", {
    hypotheses: [
      {
        title: "Guided import",
        outcome: "raise week-1 activation",
        forWhom: "new ops leads",
        benefit: "a working workspace in 5 minutes",
        feature: "a guided CSV import",
        successMetric: { name: "Week-1 activation", unit: "%", baseline: 38, target: 55, direction: "increase", timeframe: "over a 4-week pilot" },
        insightIds: [i1, i2],
      },
    ],
  });
  const h = hyp.data.created[0].id;
  const exp = await call(c, "add_experiment", {
    experiment: {
      hypothesisId: h,
      title: "Guided import pilot",
      method: "pilot",
      description: "10 new accounts get the guided import.",
      primaryMetric: { name: "Week-1 activation", unit: "%", baseline: 38, target: 55, direction: "increase" },
      guardrails: [{ name: "Support tickets", unit: "/week", baseline: 12, target: 15, direction: "decrease" }],
    },
  });
  const e = exp.data.created.id;
  await call(c, "start_experiment", { id: e });
  const res = await call(c, "record_experiment_results", { id: e, primaryActual: 61, guardrailActuals: [11], notes: "Worked." });
  const fnd = await call(c, "add_findings", {
    findings: [{ title: "Guided import lifts activation", summary: "61% vs 38%.", experimentIds: [e], hypothesisIds: [h], insightIds: [i1], confidence: "high" }],
  });
  const f = fnd.data.created[0].id;
  const req = await call(c, "add_requirements", {
    requirements: [{ title: "Guided CSV import", story: "As an ops lead I want a guided import so that I'm set up in minutes.", acceptanceCriteria: ["Shows each step"], findingIds: [f], product: "Acme app" }],
  });
  return { i1, i2, h, e, f, r: req.data.created[0].id, verdict: res.data.verdict };
}

describe("local MCP server", () => {
  it("lists the same tools as the hosted server, minus Linear", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_experiment",
        "add_findings",
        "add_hypotheses",
        "add_insights",
        "add_product_areas", // local only for now: the hosted server should get these too
        "add_products",
        "add_requirements",
        "approve_requirement",
        "delete_item",
        "get_item",
        "get_workspace",
        "link_items",
        "obsolete_requirement",
        "record_experiment_results",
        "search_items",
        "send_back_requirement",
        "start_experiment",
        "submit_requirement_for_approval",
        "update_item",
      ].sort(),
    );
    expect(c.getInstructions()).toContain("insight -> hypothesis -> experiment -> finding -> requirement");
  });

  it("builds a whole evidence chain as readable, linked files", async () => {
    const c = await connect();
    const ids = await chain(c);
    expect(ids).toMatchObject({ i1: "INS-0001", i2: "INS-0002", h: "HYP-0001", e: "EXP-0001", f: "FND-0001", r: "REQ-0001", verdict: "validated" });
    expect(files("insights")).toEqual(["INS-0001-setup-takes-too-long.md", "INS-0002-import-errors-are-unclear.md"]);

    const hyp = readFileSync(join(root, "groundwork/hypotheses/HYP-0001-guided-import.md"), "utf8");
    expect(hyp).toMatch(/^---\nid: HYP-0001\ntitle: Guided import\n/);
    expect(hyp).toContain("status: validated");
    expect(hyp).toContain("week-1 activation rises from 38 to 55 % or more over a 4-week pilot");
    expect(hyp).toContain("owner: sam");

    const loaded = load(root);
    expect(loaded.items.hypotheses[0].productArea).toBe("onboarding"); // inherited from its insights
    expect(loaded.items.requirements[0]).toMatchObject({ status: "draft", findingIds: ["FND-0001"], productArea: "onboarding" });
    expect(validate(loaded, readConfig(root)).filter((p) => p.level === "error")).toEqual([]);
  });

  it("numbers new items after the highest existing id", async () => {
    const c = await connect();
    await chain(c);
    const { data } = await call(c, "add_insights", { insights: [{ title: "Another", quote: "q", source: "survey", persona: "p" }] });
    expect(data.created[0]).toMatchObject({ id: "INS-0003", file: "groundwork/insights/INS-0003-another.md" });
  });

  it("rejects links to missing items or the wrong kind", async () => {
    const c = await connect();
    const { i1 } = await chain(c);
    const missing = await call(c, "add_hypotheses", {
      hypotheses: [{ title: "H", outcome: "o", forWhom: "f", benefit: "b", feature: "x", insightIds: ["INS-0099"] }],
    });
    expect(missing.error).toContain("no item with id INS-0099");
    const wrong = await call(c, "add_experiment", {
      experiment: { hypothesisId: i1, title: "E", method: "pilot", description: "d", primaryMetric: { name: "m", unit: "%", baseline: 1, target: 2, direction: "increase" } },
    });
    expect(wrong.error).toContain("is an insight, not a hypothesis");
  });

  it("keeps the user's notes and hand formatting of untouched files", async () => {
    const c = await connect();
    const { i1, i2 } = await chain(c);
    const file = join(root, "groundwork/insights/INS-0001-setup-takes-too-long.md");
    writeFileSync(file, readFileSync(file, "utf8") + "\n## Context\nFrom the March interviews.\n");
    const other = join(root, "groundwork/insights/INS-0002-import-errors-are-unclear.md");
    const handEdited = readFileSync(other, "utf8").replace("---\n", "---\n# hand comment\n");
    writeFileSync(other, handEdited);

    const { data } = await call(c, "update_item", { id: i1, patch: { title: "Setup takes far too long" } });
    expect(data.updated.notes).toContain("From the March interviews.");
    expect(readFileSync(file, "utf8")).toContain("## Context\nFrom the March interviews.");
    expect(readFileSync(file, "utf8")).toContain("title: Setup takes far too long");
    // The file keeps its name, so links and bookmarks don't break.
    expect(files("insights")[0]).toBe("INS-0001-setup-takes-too-long.md");

    // Deleting a hypothesis cascades, but only rewrites what changed.
    await call(c, "delete_item", { id: "HYP-0001" });
    expect(readFileSync(other, "utf8")).toBe(handEdited);
    expect(files("experiments")).toEqual([]);
    expect(load(root).items.findings[0]).toMatchObject({ hypothesisIds: ["HYP-0001"] }); // as in the hosted app
    void i2;
  });

  it("runs the approval flow with people from config.yml", async () => {
    const c = await connect();
    const { r } = await chain(c);
    expect((await call(c, "submit_requirement_for_approval", { id: r, approverId: "nobody" })).error).toContain("isn't in groundwork/config.yml");
    await call(c, "submit_requirement_for_approval", { id: r, approverId: "alex" });
    expect((await call(c, "approve_requirement", { id: r })).error).toContain("waiting for Alex");
    process.env.GROUNDWORK_USER = "alex";
    const { data } = await call(c, "approve_requirement", { id: r });
    expect(data.approved.status).toBe("approved");
    expect(load(root).items.requirements[0]).toMatchObject({ approvedBy: "alex" });
  });

  it("refuses writes once the folder was imported into the web app", async () => {
    const c = await connect();
    await chain(c);
    writeConfig(root, { ...readConfig(root), migrated: "https://groundwork.example/app" });
    const { error } = await call(c, "add_insights", { insights: [{ title: "X", quote: "q", source: "survey", persona: "p" }] });
    expect(error).toContain("imported into the Groundwork web app");
    expect((await call(c, "get_workspace")).data).toMatchObject({ readOnly: true, counts: { insight: 2 } });
  });

  it("creates config.yml on the first write in a new folder", async () => {
    rmSync(join(root, "groundwork"), { recursive: true });
    const c = await connect();
    expect((await call(c, "get_workspace")).data.initialized).toBe(false);
    await call(c, "add_insights", { insights: [{ title: "X", quote: "q", source: "survey", persona: "p" }] });
    expect(readdirSync(join(root, "groundwork")).sort()).toEqual(["config.yml", "insights"]);
  });
});

describe("product areas and products", () => {
  const insight = (productArea: string) => ({ insights: [{ title: "X", quote: "q", source: "survey", persona: "p", productArea }] });
  const requirement = (product: string) => ({
    requirements: [{ title: "Audit log", story: "Keep an audit log.", acceptanceCriteria: ["Logs kept"], origin: "regulation", product }],
  });

  it("adds areas and an item can use them", async () => {
    const c = await connect();
    const { data } = await call(c, "add_product_areas", { areas: [{ label: "Billing" }] });
    expect(data.added).toEqual([{ id: "billing", label: "Billing" }]);
    expect(data.productAreas).toHaveLength(2);
    expect((await call(c, "add_insights", insight("Billing"))).error).toBeUndefined();
    expect(readConfig(root).productAreas.map((a) => a.id)).toContain("billing");
  });

  it("skips areas already there", async () => {
    const c = await connect();
    const { data } = await call(c, "add_product_areas", { areas: [{ label: "onboarding" }] });
    expect(data.added).toEqual([]);
    expect(data.alreadyThere[0].id).toBe("onboarding");
  });

  it("reports a slug collision as an error", async () => {
    const c = await connect();
    await call(c, "add_product_areas", { areas: [{ label: "On boarding", id: "on-boarding" }] });
    expect((await call(c, "add_product_areas", { areas: [{ label: "On-boarding" }] })).error).toMatch(/already uses/);
  });

  it("adds products", async () => {
    const c = await connect();
    const { data } = await call(c, "add_products", { products: ["Acme API", "acme app"] });
    expect(data.added).toEqual(["Acme API"]);
    expect(data.alreadyThere).toEqual(["Acme app"]);
    expect((await call(c, "add_requirements", requirement("Acme API"))).error).toBeUndefined();
  });

  it("keeps other config fields", async () => {
    const c = await connect();
    await call(c, "add_product_areas", { areas: [{ label: "Billing" }] });
    await call(c, "add_products", { products: ["Acme API"] });
    const config = readConfig(root);
    expect(config.productAreas).toHaveLength(2);
    expect(config.products).toEqual(["Acme app", "Acme API"]);
    expect(config.name).toBe("Acme");
    expect(config.people).toHaveLength(2);
    expect(config.schemaVersion).toBe(1);
  });

  it("creates config.yml when missing", async () => {
    rmSync(join(root, "groundwork/config.yml"));
    const c = await connect();
    expect((await call(c, "add_product_areas", { areas: [{ label: "Billing" }] })).error).toBeUndefined();
    expect(readConfig(root).productAreas).toEqual([{ id: "billing", label: "Billing" }]);
  });

  it("refused when migrated", async () => {
    writeConfig(root, { ...readConfig(root), migrated: "https://groundwork.example/app" });
    const c = await connect();
    expect((await call(c, "add_product_areas", { areas: [{ label: "Billing" }] })).error).toMatch(/imported into the Groundwork web app/);
    expect((await call(c, "add_products", { products: ["Acme API"] })).error).toMatch(/imported into the Groundwork web app/);
    expect(readConfig(root).productAreas).toHaveLength(1);
  });

  it("refused for a viewer", async () => {
    const config = readConfig(root);
    writeConfig(root, { ...config, people: [...config.people, { id: "vic", name: "Vic", role: "viewer" }] });
    process.env.GROUNDWORK_USER = "vic";
    const c = await connect();
    expect((await call(c, "add_products", { products: ["Acme API"] })).error).toMatch(/viewer/);
  });

  it("unknown area or product points at the tool", async () => {
    const c = await connect();
    expect((await call(c, "add_insights", insight("Nope"))).error).toMatch(/add_product_areas/);
    expect((await call(c, "add_requirements", requirement("Nope"))).error).toMatch(/add_products/);
  });

  it("keeps comments and unknown keys in a hand-written config.yml", async () => {
    const file = join(root, "groundwork/config.yml");
    writeFileSync(
      file,
      "# Our settings\nname: Acme\nteam: growth\nproductAreas:\n  - { id: onboarding, label: Onboarding } # first area\nproducts: [Acme app]\npeople:\n  - { id: sam, name: Sam, role: owner }\n",
    );
    const c = await connect();
    expect((await call(c, "add_product_areas", { areas: [{ label: "Billing" }] })).error).toBeUndefined();
    expect((await call(c, "add_products", { products: ["Acme API"] })).error).toBeUndefined();
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# Our settings");
    expect(text).toContain("# first area");
    expect(text).toContain("team: growth");
    expect(readConfig(root).productAreas.map((a) => a.id)).toEqual(["onboarding", "billing"]);
    expect(readConfig(root).products).toEqual(["Acme app", "Acme API"]);
  });

  it("leaves config.yml untouched when nothing is added", async () => {
    const file = join(root, "groundwork/config.yml");
    const before = readFileSync(file, "utf8") + "# hand note\n";
    writeFileSync(file, before);
    const c = await connect();
    await call(c, "add_product_areas", { areas: [{ label: "Onboarding" }] });
    await call(c, "add_products", { products: ["acme app"] });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("matches a requirement's product regardless of case", async () => {
    const c = await connect();
    const { data, error } = await call(c, "add_requirements", requirement("acme app"));
    expect(error).toBeUndefined();
    expect(load(root).items.requirements.find((r) => r.id === data.created[0].id)?.product).toBe("Acme app");
  });

  it("no item files written", async () => {
    const c = await connect();
    await chain(c);
    const count = () => Object.values(load(root).items).flat().length;
    const before = count();
    expect((await call(c, "add_product_areas", { areas: [{ label: "Billing" }] })).error).toBeUndefined();
    expect(count()).toBe(before);
  });
});

describe("validate", () => {
  it("reports broken files, links and duplicate ids", async () => {
    const c = await connect();
    await chain(c);
    const dir = join(root, "groundwork/insights");
    writeFileSync(join(dir, "INS-0001-copy.md"), readFileSync(join(dir, "INS-0001-setup-takes-too-long.md")));
    writeFileSync(join(dir, "broken.md"), "no frontmatter here");
    const hyp = join(root, "groundwork/hypotheses/HYP-0001-guided-import.md");
    writeFileSync(hyp, readFileSync(hyp, "utf8").replace("- INS-0002", "- INS-0042"));

    const problems = validate(load(root), readConfig(root)).map((p) => `${p.file}: ${p.message}`);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/INS-0001-setup-takes-too-long\.md: duplicate id INS-0001/),
        expect.stringMatching(/broken\.md: no YAML frontmatter/),
        expect.stringMatching(/HYP-0001-guided-import\.md: insightIds: INS-0042 doesn't exist/),
      ]),
    );
  });
});
