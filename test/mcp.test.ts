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
import { writeProduct } from "../src/store/products";

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
  const need = await call(c, "add_requirements", {
    requirements: [
      {
        kind: "stakeholder",
        title: "Get set up without help",
        story: "As a new ops lead I want to import our data on my first day so that my team can start straight away.",
        stakeholder: "Ops leads",
        acceptanceCriteria: ["A new account imports its first data set unaided"],
        findingIds: [f],
      },
    ],
  });
  const sr = need.data.created[0].id;
  const req = await call(c, "add_requirements", {
    requirements: [
      {
        kind: "solution",
        title: "Guided CSV import",
        story: "The CSV import shall guide the user through mapping columns and fixing errors.",
        acceptanceCriteria: ["Shows each step"],
        findingIds: [f],
        stakeholderIds: [sr],
        product: "Acme app",
      },
    ],
  });
  return { i1, i2, h, e, f, sr, r: req.data.created[0].id, verdict: res.data.verdict };
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
        "add_product_versions",
        "add_products",
        "add_requirements",
        "approve_requirement",
        "delete_item",
        "get_item",
        "get_workspace",
        "link_items",
        "correct_release",
        "get_release",
        "link_tickets",
        "obsolete_requirement",
        "plan_requirements",
        "release_requirements",
        "release_version",
        "record_experiment_results",
        "search_items",
        "send_back_requirement",
        "start_experiment",
        "submit_requirement_for_approval",
        "unlink_tickets",
        "update_item",
        "update_tickets",
      ].sort(),
    );
    expect(c.getInstructions()).toContain("insight -> hypothesis -> experiment -> finding -> requirement");
  });

  it("tells agents how to plan work with requirements", async () => {
    const text = (await connect()).getInstructions()!;
    for (const phrase of ["When you plan work", "New need", "Change", "Fix", "before writing code", "REQ ids", "approvedBy", "link_tickets", "won't do"]) {
      expect(text).toContain(phrase);
    }
  });

  it("tells agents that recording evidence directly isn't planning work", async () => {
    const text = (await connect()).getInstructions()!;
    expect(text).toContain("isn't planning work");
  });

  it("lets a product manager run discovery and requirements end to end", async () => {
    writeConfig(root, { ...readConfig(root), people: [...readConfig(root).people, { id: "pia", name: "Pia", role: "editor" }] });
    process.env.GROUNDWORK_USER = "pia";
    const c = await connect();
    const { f, sr, r } = await chain(c);
    expect((await call(c, "submit_requirement_for_approval", { id: sr, approverId: "pia" })).error).toBeUndefined();
    expect((await call(c, "approve_requirement", { id: sr })).data.approved.status).toBe("approved");
    const req = load(root).items.requirements.find((x) => x.id === r)!;
    expect(req).toMatchObject({ kind: "solution", findingIds: [f], stakeholderIds: [sr] });
    expect(req.recordedBy).toBeUndefined();
    expect(validate(load(root), readConfig(root)).filter((p) => p.level === "error")).toEqual([]);
  });

  it("builds a whole evidence chain as readable, linked files", async () => {
    const c = await connect();
    const ids = await chain(c);
    expect(ids).toMatchObject({ i1: "INS-0001", i2: "INS-0002", h: "HYP-0001", e: "EXP-0001", f: "FND-0001", sr: "REQ-0001", r: "REQ-0002", verdict: "validated" });
    expect(files("insights")).toEqual(["INS-0001-setup-takes-too-long.md", "INS-0002-import-errors-are-unclear.md"]);

    const hyp = readFileSync(join(root, "groundwork/hypotheses/HYP-0001-guided-import.md"), "utf8");
    expect(hyp).toMatch(/^---\nid: HYP-0001\ntitle: Guided import\n/);
    expect(hyp).toContain("status: validated");
    expect(hyp).toContain("week-1 activation rises from 38 to 55 % or more over a 4-week pilot");
    expect(hyp).toContain("owner: sam");

    const loaded = load(root);
    expect(loaded.items.hypotheses[0].productArea).toBe("onboarding"); // inherited from its insights
    expect(loaded.items.requirements.find((r) => r.id === "REQ-0002")).toMatchObject({
      kind: "solution",
      status: "draft",
      findingIds: ["FND-0001"],
      stakeholderIds: ["REQ-0001"],
      productArea: "onboarding",
    });
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
    expect(load(root).items.requirements.find((x) => x.id === r)).toMatchObject({ approvedBy: "alex" });
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
  /** A solution requirement for `product`, after adding the stakeholder requirement it fulfils. */
  const requirement = async (c: Client, product: string) => {
    const need = await call(c, "add_requirements", {
      requirements: [
        { kind: "stakeholder", title: "Prove who imported what", story: "As a compliance officer I want to see every import so that we pass audits.", acceptanceCriteria: ["Imports can be traced"], origin: "regulation" },
      ],
    });
    return {
      requirements: [
        { kind: "solution", title: "Audit log", story: "The system shall log every import.", acceptanceCriteria: ["Logs kept"], stakeholderIds: [need.data.created[0].id], product },
      ],
    };
  };

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
    expect((await call(c, "add_requirements", await requirement(c, "Acme API"))).error).toBeUndefined();
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

  it("creates config.yml when missing, and puts the product and its areas in a product file", async () => {
    rmSync(join(root, "groundwork/config.yml"));
    const c = await connect();
    expect((await call(c, "add_product_areas", { areas: [{ label: "Billing" }] })).error).toMatch(/Add a product first/);
    expect((await call(c, "add_products", { products: ["Acme app"] })).error).toBeUndefined();
    expect((await call(c, "add_product_areas", { areas: [{ label: "Billing" }] })).error).toBeUndefined();
    expect(readConfig(root).schemaVersion).toBe(2);
    expect(load(root).products[0].areas).toEqual([{ id: "billing", label: "Billing" }]);
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
    expect((await call(c, "add_requirements", await requirement(c, "Nope"))).error).toMatch(/add_products/);
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
    const { data, error } = await call(c, "add_requirements", await requirement(c, "acme app"));
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

describe("two-layer requirements", () => {
  const secretary = {
    kind: "stakeholder",
    title: "See every practitioner's free slots",
    story:
      "As a medical secretary I want a view of the calendars of all practitioners in the clinic with their unbooked slots highlighted so that I can find them and book appointments easily.",
    stakeholder: "Medical secretaries",
    acceptanceCriteria: ["Free slots of all practitioners are visible at once"],
  };
  const bookingView = (stakeholderIds?: string[]) => ({
    kind: "solution",
    title: "Appointment view with free slots",
    story:
      "The appointment view used by medical secretaries shall show the calendars of the selected practitioners with free slots highlighted. It shall be possible to click a free slot to start booking. It shall be possible to add or remove practitioners in the view.",
    acceptanceCriteria: ["Free slots are highlighted", "Clicking a free slot starts the booking flow"],
    ...(stakeholderIds ? { stakeholderIds } : {}),
  });
  const addStakeholder = async (c: Client) => (await call(c, "add_requirements", { requirements: [secretary] })).data;

  it("adds a stakeholder story and a solution that fulfils it, without findings or an origin", async () => {
    const c = await connect();
    const need = await addStakeholder(c);
    expect(need.warnings).toBeUndefined();
    const sr = need.created[0].id;
    const { data, error } = await call(c, "add_requirements", { requirements: [bookingView([sr])] });
    expect(error).toBeUndefined();
    expect(data.warnings).toBeUndefined();
    const item = (await call(c, "get_item", { id: sr })).data;
    expect(item.fulfilledBy.map((x: { id: string }) => x.id)).toEqual([data.created[0].id]);
    expect(item.warnings).toBeUndefined();
    expect(validate(load(root), readConfig(root))).toEqual([]);
  });

  it("refuses a solution requirement that fulfils no stakeholder requirement", async () => {
    const c = await connect();
    expect((await call(c, "add_requirements", { requirements: [bookingView()] })).error).toMatch(/must fulfil at least one stakeholder requirement/);
    expect((await call(c, "add_requirements", { requirements: [bookingView([])] })).error).toMatch(/must fulfil at least one stakeholder requirement/);
  });

  it("requires the kind", async () => {
    const c = await connect();
    const { kind: _kind, ...noKind } = secretary;
    void _kind;
    expect((await call(c, "add_requirements", { requirements: [noKind] })).error).toMatch(/kind/);
  });

  it("refuses stakeholder links on a stakeholder requirement, or links to a solution requirement", async () => {
    const c = await connect();
    const sr = (await addStakeholder(c)).created[0].id;
    expect((await call(c, "add_requirements", { requirements: [{ ...secretary, stakeholderIds: [sr] }] })).error).toMatch(/only for solution requirements/);
    const sol = (await call(c, "add_requirements", { requirements: [bookingView([sr])] })).data.created[0].id;
    expect((await call(c, "add_requirements", { requirements: [bookingView([sol])] })).error).toMatch(/is a solution requirement, not a stakeholder requirement/);
  });

  it("warns, but saves, when the wording doesn't fit the layer", async () => {
    const c = await connect();
    const need = await call(c, "add_requirements", { requirements: [{ ...secretary, story: "Secretaries need to see free slots." }] });
    expect(need.error).toBeUndefined();
    expect(need.data.warnings[0]).toMatch(/As a <role> I want <need> so that <reason>/);
    const sol = await call(c, "add_requirements", { requirements: [{ ...bookingView([need.data.created[0].id]), story: "Show free slots in the calendar." }] });
    expect(sol.error).toBeUndefined();
    expect(sol.data.warnings[0]).toMatch(/"shall" statements/);
    const problems = validate(load(root), readConfig(root));
    expect(problems.filter((p) => p.level === "error")).toEqual([]);
    expect(problems.filter((p) => p.level === "warning")).toHaveLength(2);
  });

  it("keeps the link when updating", async () => {
    const c = await connect();
    const sr = (await addStakeholder(c)).created[0].id;
    const sol = (await call(c, "add_requirements", { requirements: [bookingView([sr])] })).data.created[0].id;
    expect((await call(c, "update_item", { id: sol, patch: { stakeholderIds: [] } })).error).toMatch(/must fulfil at least one/);
    expect((await call(c, "update_item", { id: sr, patch: { kind: "solution", stakeholderIds: [sr] } })).error).toBeDefined();
    const reworded = await call(c, "update_item", { id: sr, patch: { story: "Free slots, please." } });
    expect(reworded.error).toBeUndefined();
    expect(reworded.data.warnings).toHaveLength(1);
  });

  it("won't delete the only stakeholder requirement a solution fulfils", async () => {
    const c = await connect();
    const sr = (await addStakeholder(c)).created[0].id;
    const sol = (await call(c, "add_requirements", { requirements: [bookingView([sr])] })).data.created[0].id;
    expect((await call(c, "delete_item", { id: sr })).error).toMatch(/only fulfils/);
    await call(c, "delete_item", { id: sol });
    expect((await call(c, "delete_item", { id: sr })).error).toBeUndefined();
  });

  it("validate flags unfulfilled stakeholder requirements and unlinked solution requirements", async () => {
    const c = await connect();
    const sr = (await addStakeholder(c)).created[0].id;
    expect((await call(c, "get_item", { id: sr })).data.warnings).toEqual(["Not yet fulfilled by any solution requirement."]);
    let problems = validate(load(root), readConfig(root));
    expect(problems).toEqual([expect.objectContaining({ level: "warning", message: "not yet fulfilled by any solution requirement" })]);

    // A hand-edited solution requirement without a stakeholder link fails validation.
    const sol = (await call(c, "add_requirements", { requirements: [bookingView([sr])] })).data.created[0];
    const file = join(root, sol.file);
    writeFileSync(file, readFileSync(file, "utf8").replace(/stakeholderIds:\n {2}- REQ-0001\n/, ""));
    problems = validate(load(root), readConfig(root));
    expect(problems.filter((p) => p.level === "error").map((p) => p.message)).toEqual([expect.stringMatching(/must fulfil at least one stakeholder requirement/)]);

    // Obsolete requirements are left alone.
    writeFileSync(file, readFileSync(file, "utf8").replace("status: draft", "status: obsolete"));
    expect(validate(load(root), readConfig(root)).filter((p) => p.level === "error")).toEqual([]);
  });
});

describe("approval on someone's behalf", () => {
  let c: Client;
  let id: string;
  beforeEach(async () => {
    const config = readConfig(root);
    writeConfig(root, { ...config, people: [...config.people, { id: "vic", name: "Vic", role: "viewer" }] });
    c = await connect();
    const { data } = await call(c, "add_requirements", {
      requirements: [
        {
          kind: "stakeholder",
          title: "Book appointments quickly",
          story: "As a medical secretary I want to see free slots so that I can book appointments quickly.",
          acceptanceCriteria: ["Free slots are visible"],
        },
      ],
    });
    id = data.created[0].id;
  });

  it("records a verbal approval of a draft", async () => {
    const { data } = await call(c, "approve_requirement", { id, approvedBy: "alex", note: "Approved by Alex in sprint planning" });
    expect(data.approved.status).toBe("approved");
    expect(load(root).items.requirements[0]).toMatchObject({ approvedBy: "alex", recordedBy: "sam", approvalNote: "Approved by Alex in sprint planning" });
  });

  it("refuses an approver who isn't in config.yml", async () => {
    expect((await call(c, "approve_requirement", { id, approvedBy: "nobody" })).error).toMatch(/isn't in groundwork\/config.yml/);
  });

  it("refuses a viewer as approver", async () => {
    expect((await call(c, "approve_requirement", { id, approvedBy: "vic" })).error).toMatch(/Vic is a viewer/);
  });

  it("refuses a requirement that's already approved", async () => {
    await call(c, "approve_requirement", { id, approvedBy: "alex" });
    expect((await call(c, "approve_requirement", { id, approvedBy: "alex" })).error).toMatch(/is approved/);
  });

  it("naming yourself as approvedBy doesn't skip the approver check", async () => {
    await call(c, "submit_requirement_for_approval", { id, approverId: "alex" });
    expect((await call(c, "approve_requirement", { id, approvedBy: "sam" })).error).toMatch(/waiting for Alex/);
    expect(load(root).items.requirements[0].status).toBe("awaiting-approval");
  });

  it("refuses recording an approval from someone other than the person asked", async () => {
    const config = readConfig(root);
    writeConfig(root, { ...config, people: [...config.people, { id: "pat", name: "Pat", role: "editor" }] });
    await call(c, "submit_requirement_for_approval", { id, approverId: "alex" });
    expect((await call(c, "approve_requirement", { id, approvedBy: "pat" })).error).toMatch(/waiting for Alex/);
    expect((await call(c, "approve_requirement", { id, approvedBy: "alex" })).data.approved.status).toBe("approved");
  });

  it("without approvedBy, a draft still needs submitting first and points at approvedBy", async () => {
    expect((await call(c, "approve_requirement", { id })).error).toMatch(/approvedBy/);
  });
});

describe("product files", () => {
  let c: Client;
  beforeEach(async () => {
    writeConfig(root, { ...readConfig(root), schemaVersion: 2, productAreas: [], products: [] });
    writeProduct(root, { id: "PRD-0001", title: "Clinicare Web Application", areas: [{ id: "scheduling", label: "Scheduling" }], versions: [] });
    c = await connect();
  });

  it("stores a requirement's product as the product id", async () => {
    const need = await call(c, "add_requirements", {
      requirements: [{ kind: "stakeholder", title: "Book", story: "As a secretary I want slots so that I can book.", acceptanceCriteria: ["a"] }],
    });
    const { data, error } = await call(c, "add_requirements", {
      requirements: [
        { kind: "solution", title: "Slots", story: "The system shall show slots.", acceptanceCriteria: ["a"], stakeholderIds: [need.data.created[0].id], product: "clinicare web application" },
      ],
    });
    expect(error).toBeUndefined();
    expect(load(root).items.requirements.find((r) => r.id === data.created[0].id)?.product).toBe("PRD-0001");
  });

  it("resolves an area label from a product file", async () => {
    await call(c, "add_insights", { insights: [{ title: "X", quote: "q", source: "survey", persona: "p", productArea: "Scheduling" }] });
    expect(load(root).items.insights[0].productArea).toBe("scheduling");
  });

  it("get_workspace shows the catalogue", async () => {
    const { data } = await call(c, "get_workspace");
    expect(data.catalogue).toBe("files");
    expect(data.products).toEqual([expect.objectContaining({ id: "PRD-0001", title: "Clinicare Web Application", areas: [{ id: "scheduling", label: "Scheduling" }] })]);
  });
});

describe("product tools on product files", () => {
  const AREAS = ["Settings and configuration", "Scheduling", "Prescriptions", "Medical Records", "Patient Data Protection"];
  let c: Client;
  beforeEach(async () => {
    writeConfig(root, { ...readConfig(root), schemaVersion: 1, productAreas: [], products: [] });
    c = await connect();
  });

  it("creates a product file in a new project and moves it to schemaVersion 2", async () => {
    const { data, error } = await call(c, "add_products", { products: ["Clinicare Web Application"] });
    expect(error).toBeUndefined();
    expect(data.added).toEqual([expect.objectContaining({ id: "PRD-0001", title: "Clinicare Web Application" })]);
    expect(readdirSync(join(root, "groundwork/products"))).toEqual(["PRD-0001-clinicare-web-application.md"]);
    expect(readConfig(root).schemaVersion).toBe(2);
  });

  it("adds areas and planned versions to the product file", async () => {
    await call(c, "add_products", { products: ["Clinicare Web Application"] });
    expect((await call(c, "add_product_areas", { areas: AREAS.map((label) => ({ label })) })).error).toBeUndefined();
    expect((await call(c, "add_product_versions", { versions: [{ version: "1.0" }, { version: "1.1" }] })).error).toBeUndefined();
    const p = load(root).products[0];
    expect(p.areas.map((a) => a.label)).toEqual(AREAS);
    expect(p.versions).toEqual([{ version: "1.0", status: "planned" }, { version: "1.1", status: "planned" }]);
  });

  it("with two products, needs the product, and refuses an area id another product uses", async () => {
    await call(c, "add_products", { products: ["Clinicare Web Application", "Clinicare Mobile"] });
    expect((await call(c, "add_product_areas", { areas: [{ label: "Scheduling" }] })).error).toMatch(/Name the product/);
    expect((await call(c, "add_product_areas", { product: "PRD-0001", areas: [{ label: "Scheduling" }] })).error).toBeUndefined();
    expect((await call(c, "add_product_areas", { product: "Clinicare Mobile", areas: [{ label: "Scheduling" }] })).error).toMatch(/already uses/);
  });

  it("refuses areas before there is a product", async () => {
    expect((await call(c, "add_product_areas", { areas: [{ label: "Scheduling" }] })).error).toMatch(/Add a product first/);
  });

  it("refuses a requirement's product before any product exists", async () => {
    const need = await call(c, "add_requirements", {
      requirements: [{ kind: "stakeholder", title: "Book", story: "As a secretary I want slots so that I can book.", acceptanceCriteria: ["a"] }],
    });
    const { error } = await call(c, "add_requirements", {
      requirements: [{ kind: "solution", title: "Slots", story: "The system shall show slots.", acceptanceCriteria: ["a"], stakeholderIds: [need.data.created[0].id], product: "Whatever" }],
    });
    expect(error).toMatch(/Add a product first/);
  });

  it("refuses versions in a project that hasn't migrated", async () => {
    writeConfig(root, { ...readConfig(root), products: ["Acme app"] });
    expect((await call(c, "add_product_versions", { versions: [{ version: "1.0" }] })).error).toMatch(/groundwork migrate/);
  });
});

describe("planning requirements for versions", () => {
  let c: Client;
  let need: string;
  let sol: string;
  const approve = async (id: string, extra: Record<string, unknown> = {}) => {
    await call(c, "submit_requirement_for_approval", { id, approverId: "sam" });
    return call(c, "approve_requirement", { id, ...extra });
  };
  beforeEach(async () => {
    writeConfig(root, { ...readConfig(root), schemaVersion: 2, productAreas: [], products: [] });
    writeProduct(root, {
      id: "PRD-0001",
      title: "Clinicare Web Application",
      areas: [],
      versions: [
        { version: "1.0", status: "released" },
        { version: "1.1", status: "planned" },
        { version: "1.2", status: "planned" },
      ],
    });
    c = await connect();
    need = (await call(c, "add_requirements", { requirements: [{ kind: "stakeholder", title: "Book", story: "As a secretary I want slots so that I can book.", acceptanceCriteria: ["a"] }] })).data.created[0].id;
    sol = (await call(c, "add_requirements", { requirements: [{ kind: "solution", title: "Slots", story: "The booking view shall show free slots.", acceptanceCriteria: ["a"], stakeholderIds: [need] }] })).data.created[0].id;
  });
  const stored = (id: string) => load(root).items.requirements.find((r) => r.id === id)!;

  it("asks which version a solution requirement is planned for", async () => {
    expect((await approve(sol)).error).toMatch(/Which version is "Slots" planned for\? Pass plannedFor: one of 1.1, 1.2/);
  });

  it("approves and plans in one step", async () => {
    expect((await approve(sol, { plannedFor: "1.1" })).error).toBeUndefined();
    expect(stored(sol)).toMatchObject({ status: "approved", plannedFor: "1.1" });
  });

  it("refuses a released version, or one that doesn't exist", async () => {
    expect((await approve(sol, { plannedFor: "1.0" })).error).toMatch(/1.0 isn't a planned version of Clinicare Web Application. Planned: 1.1, 1.2/);
    expect((await call(c, "approve_requirement", { id: sol, plannedFor: "9.9" })).error).toMatch(/9.9 isn't a planned version/);
  });

  it("approves a stakeholder requirement without a version, and refuses one with a version", async () => {
    expect((await approve(need, { plannedFor: "1.1" })).error).toMatch(/only solution requirements are planned for versions/);
    expect((await call(c, "approve_requirement", { id: need })).error).toBeUndefined();
  });

  it("records a verbal approval with its version", async () => {
    expect((await call(c, "approve_requirement", { id: sol, approvedBy: "alex", plannedFor: "1.2" })).error).toBeUndefined();
    expect(stored(sol)).toMatchObject({ approvedBy: "alex", recordedBy: "sam", plannedFor: "1.2" });
  });

  const replacement = async (replaces: string[]) =>
    call(c, "add_requirements", {
      requirements: [{ kind: "solution", title: "Slots v2", story: "The booking view shall show free 15-minute slots.", acceptanceCriteria: ["a"], stakeholderIds: [need], replaces }],
    });

  it("keeps a replaced requirement valid until the version its replacement ships in", async () => {
    await approve(sol, { plannedFor: "1.1" });
    const next = (await replacement([sol])).data.created[0].id;
    await approve(next, { plannedFor: "1.2" });
    expect(stored(sol)).toMatchObject({ status: "approved", obsoletePlannedFor: "1.2", obsoletedBy: [next] });
    await call(c, "plan_requirements", { ids: [next], version: "1.1" });
    expect(stored(sol).obsoletePlannedFor).toBe("1.1");
  });

  it("refuses replacing a draft or an obsolete requirement", async () => {
    expect((await replacement([sol])).error).toMatch(/"Slots" is a draft: update it instead of replacing it/);
    await approve(sol, { plannedFor: "1.1" });
    expect((await call(c, "obsolete_requirement", { id: sol })).error).toBeUndefined();
    expect((await replacement([sol])).error).toMatch(/"Slots" is already obsolete/);
  });

  it("obsolete_requirement can wait for a version", async () => {
    await approve(sol, { plannedFor: "1.1" });
    expect((await call(c, "obsolete_requirement", { id: sol, inVersion: "1.2" })).error).toBeUndefined();
    expect(stored(sol)).toMatchObject({ status: "approved", obsoletePlannedFor: "1.2" });
  });

  it("deleting a replacement takes back the old requirement's planned obsolescence", async () => {
    await approve(sol, { plannedFor: "1.1" });
    const next = (await replacement([sol])).data.created[0].id;
    await approve(next, { plannedFor: "1.2" });
    expect((await call(c, "delete_item", { id: next })).error).toBeUndefined();
    const old = stored(sol);
    expect(old.obsoletePlannedFor).toBeUndefined();
    expect(old.obsoletedBy ?? []).toEqual([]);
  });

  it("with two replacements, the old requirement stays valid until the last one ships", async () => {
    await approve(sol, { plannedFor: "1.1" });
    const b = (await replacement([sol])).data.created[0].id;
    const d = (await replacement([sol])).data.created[0].id;
    await approve(b, { plannedFor: "1.2" });
    await approve(d, { plannedFor: "1.1" });
    expect(stored(sol)).toMatchObject({ obsoletePlannedFor: "1.2", obsoletedBy: [b, d] });
    await call(c, "plan_requirements", { ids: [b], version: "1.1" });
    expect(stored(sol).obsoletePlannedFor).toBe("1.1");
  });

  it("refuses replacing a requirement of another product", async () => {
    await approve(sol, { plannedFor: "1.1" });
    writeProduct(root, { id: "PRD-0002", title: "Clinicare Mobile", areas: [], versions: [{ version: "5.0", status: "planned" }] });
    const { error } = await call(c, "add_requirements", {
      requirements: [{ kind: "solution", title: "Mobile slots", story: "The app shall show slots.", acceptanceCriteria: ["a"], stakeholderIds: [need], product: "PRD-0002", replaces: [sol] }],
    });
    expect(error).toMatch(/another product/);
  });

  it("refuses changing the product of a planned requirement", async () => {
    await approve(sol, { plannedFor: "1.1" });
    writeProduct(root, { id: "PRD-0002", title: "Clinicare Mobile", areas: [], versions: [{ version: "1.1", status: "planned" }] });
    expect((await call(c, "update_item", { id: sol, patch: { product: "PRD-0002" } })).error).toMatch(/planned for 1.1/);
  });

  it("refuses adding replaces after approval, and replacing itself", async () => {
    await approve(sol, { plannedFor: "1.1" });
    const next = (await replacement([sol])).data.created[0].id;
    expect((await call(c, "update_item", { id: next, patch: { replaces: [next] } })).error).toMatch(/can't replace itself/);
    await approve(next, { plannedFor: "1.2" });
    const other = (await call(c, "add_requirements", { requirements: [{ kind: "solution", title: "Other", story: "The view shall do x.", acceptanceCriteria: ["a"], stakeholderIds: [need] }] })).data.created[0].id;
    await approve(other, { plannedFor: "1.1" });
    expect((await call(c, "update_item", { id: next, patch: { replaces: [sol, other] } })).error).toMatch(/only before it's approved/);
  });

  it("re-plans an approved requirement, and refuses a draft", async () => {
    expect((await call(c, "plan_requirements", { ids: [sol], version: "1.2" })).error).toMatch(/approve it first/);
    await approve(sol, { plannedFor: "1.1" });
    expect((await call(c, "plan_requirements", { ids: [sol], version: "1.2" })).error).toBeUndefined();
    expect(stored(sol).plannedFor).toBe("1.2");
  });
});

describe("replacing requirements without versions", () => {
  it("makes the old requirement obsolete when its replacement is approved, as before", async () => {
    const c = await connect();
    const need = (await call(c, "add_requirements", { requirements: [{ kind: "stakeholder", title: "Book", story: "As a secretary I want slots so that I can book.", acceptanceCriteria: ["a"] }] })).data.created[0].id;
    const add = async (title: string, extra: Record<string, unknown> = {}) =>
      (await call(c, "add_requirements", { requirements: [{ kind: "solution", title, story: "The view shall show slots.", acceptanceCriteria: ["a"], stakeholderIds: [need], ...extra }] })).data.created[0].id;
    const ok = async (id: string) => {
      await call(c, "submit_requirement_for_approval", { id, approverId: "sam" });
      expect((await call(c, "approve_requirement", { id })).error).toBeUndefined();
    };
    const old = await add("Slots");
    await ok(old);
    const next = await add("Slots v2", { replaces: [old] });
    await ok(next);
    expect(load(root).items.requirements.find((r) => r.id === old)).toMatchObject({ status: "obsolete", obsoletedBy: [next] });
  });

  it("tells agents to replace with replaces", async () => {
    const text = (await connect()).getInstructions()!;
    expect(text).toContain("replaces");
    expect(text).not.toContain("obsolete_requirement and replacedBy");
  });
});

describe("stakeholder progress in get_item", () => {
  it("shows how many of a need's solution requirements are released", async () => {
    writeConfig(root, { ...readConfig(root), schemaVersion: 2, productAreas: [], products: [] });
    writeProduct(root, { id: "PRD-0001", title: "Clinicare Web Application", areas: [], versions: [{ version: "1.0", status: "planned" }] });
    const c = await connect();
    const need = (await call(c, "add_requirements", { requirements: [{ kind: "stakeholder", title: "Book", story: "As a secretary I want slots so that I can book.", acceptanceCriteria: ["a"] }] })).data.created[0].id;
    await call(c, "add_requirements", { requirements: [{ kind: "solution", title: "Slots", story: "The view shall show slots.", acceptanceCriteria: ["a"], stakeholderIds: [need] }] });
    const { data } = await call(c, "get_item", { id: need });
    expect(data.progress).toMatchObject({ released: 0, total: 1 });
  });
});

describe("releasing", () => {
  let c: Client;
  let a: string;
  let b: string;
  const PRODUCT = "groundwork/products/PRD-0001-clinicare-web-application.md";
  beforeEach(async () => {
    writeConfig(root, { ...readConfig(root), schemaVersion: 2, productAreas: [], products: [] });
    writeProduct(root, { id: "PRD-0001", title: "Clinicare Web Application", areas: [], versions: [{ version: "1.0", status: "planned" }, { version: "1.1", status: "planned" }] });
    c = await connect();
    const need = (await call(c, "add_requirements", { requirements: [{ kind: "stakeholder", title: "Book", story: "As a secretary I want slots so that I can book.", acceptanceCriteria: ["a"] }] })).data.created[0].id;
    const add = async (title: string) =>
      (await call(c, "add_requirements", { requirements: [{ kind: "solution", title, story: "The view shall show slots.", acceptanceCriteria: ["a"], stakeholderIds: [need] }] })).data.created[0].id;
    a = await add("Slots");
    b = await add("Filters");
    for (const id of [a, b]) {
      await call(c, "submit_requirement_for_approval", { id, approverId: "sam" });
      await call(c, "approve_requirement", { id, plannedFor: "1.0" });
    }
  });
  const stored = (id: string) => load(root).items.requirements.find((r) => r.id === id)!;

  it("lists what's planned for a version", async () => {
    const { data } = await call(c, "get_release", { version: "1.0" });
    expect(data.status).toBe("planned");
    expect(data.planned.map((x: { id: string }) => x.id).sort()).toEqual([a, b].sort());
  });

  it("releases what shipped and moves the rest", async () => {
    expect((await call(c, "release_version", { version: "1.0", shipped: [a] })).error).toMatch(new RegExp(`${b}.*moveTo`, "s"));
    const { data, error } = await call(c, "release_version", { version: "1.0", shipped: [a], moveTo: "1.1" });
    expect(error).toBeUndefined();
    expect(data.report.introduced.map((x: { id: string }) => x.id)).toEqual([a]);
    expect(load(root).products[0].versions[0]).toMatchObject({ version: "1.0", status: "released", releasedBy: "sam" });
    expect(stored(b).plannedFor).toBe("1.1");
    expect((await call(c, "get_release", { version: "1.0" })).data.status).toBe("released");
    expect((await call(c, "release_version", { version: "1.0", shipped: [] })).error).toMatch(/correct_release/);
  });

  it("corrects a released version only with a reason, and records it", async () => {
    await call(c, "release_version", { version: "1.0", shipped: [a, b] });
    expect((await call(c, "correct_release", { version: "1.0", removeShipped: [b], moveTo: "1.1" })).error).toBeDefined();
    const { error } = await call(c, "correct_release", { version: "1.0", reason: "Filters were behind a flag", removeShipped: [b], moveTo: "1.1" });
    expect(error).toBeUndefined();
    expect(load(root).products[0].versions[0].corrections?.[0]).toMatchObject({ by: "sam", reason: "Filters were behind a flag" });
    expect(readFileSync(join(root, PRODUCT), "utf8")).toContain("Filters were behind a flag");
  });

  it("adds a requirement shipped later to a released version", async () => {
    await call(c, "release_version", { version: "1.0", shipped: [a], moveTo: "1.1" });
    expect((await call(c, "release_requirements", { version: "1.0", ids: [b] })).error).toBeUndefined();
    expect(stored(b).releasedIn).toBe("1.0");
  });

  it("refuses a viewer", async () => {
    const config = readConfig(root);
    writeConfig(root, { ...config, people: [...config.people, { id: "vic", name: "Vic", role: "viewer" }] });
    process.env.GROUNDWORK_USER = "vic";
    expect((await call(c, "release_version", { version: "1.0", shipped: [a, b] })).error).toMatch(/viewer/);
  });

  it("sorts planned requirements by ticket status, and keeps tickets linked before the release", async () => {
    await call(c, "link_tickets", { requirementIds: [a], ticket: { tracker: "linear", key: "CLN-1", done: true } });
    const { data } = await call(c, "get_release", { version: "1.0" });
    expect(data.ready.map((x: { id: string }) => x.id)).toEqual([a]);
    expect(data.noTickets.map((x: { id: string }) => x.id)).toEqual([b]);
    await call(c, "release_version", { version: "1.0", shipped: [a], moveTo: "1.1" });
    expect((await call(c, "unlink_tickets", { requirementIds: [a], ticket: { tracker: "linear", key: "CLN-1" } })).error).toMatch(/part of that release's record/);
    await call(c, "link_tickets", { requirementIds: [a], ticket: { tracker: "linear", key: "CLN-77" } });
    expect((await call(c, "unlink_tickets", { requirementIds: [a], ticket: { tracker: "linear", key: "CLN-77" } })).error).toBeUndefined();
  });

  it("refuses someone who isn't in config.yml", async () => {
    process.env.GROUNDWORK_USER = "mallory";
    expect((await call(c, "release_version", { version: "1.0", shipped: [a, b] })).error).toMatch(/config.yml people/);
  });

  it("protects released requirements, and the needs they meet, from edits and deletes", async () => {
    await call(c, "release_version", { version: "1.0", shipped: [a], moveTo: "1.1" });
    expect((await call(c, "update_item", { id: a, patch: { title: "Rewritten" } })).error).toMatch(/shipped in 1.0/);
    expect((await call(c, "delete_item", { id: a })).error).toMatch(/shipped in 1.0/);
    const need = stored(a).stakeholderIds![0];
    expect((await call(c, "delete_item", { id: need })).error).toMatch(/released/);
    expect((await call(c, "update_item", { id: b, patch: { title: "Still a plan" } })).error).toBeUndefined();
  });
});

describe("tickets over MCP", () => {
  let c: Client;
  let need: string;
  let sol: string;
  beforeEach(async () => {
    c = await connect();
    need = (await call(c, "add_requirements", { requirements: [{ kind: "stakeholder", title: "Book", story: "As a secretary I want slots so that I can book.", acceptanceCriteria: ["a"] }] })).data.created[0].id;
    sol = (await call(c, "add_requirements", { requirements: [{ kind: "solution", title: "Slots", story: "The view shall show slots.", acceptanceCriteria: ["a"], stakeholderIds: [need] }] })).data.created[0].id;
  });

  it("links tickets to solution requirements only, and finds requirements by ticket key", async () => {
    expect((await call(c, "link_tickets", { requirementIds: [need], ticket: { tracker: "linear", key: "CLN-142" } })).error).toMatch(/solution requirement/);
    expect((await call(c, "link_tickets", { requirementIds: [sol], ticket: { tracker: "linear", key: "CLN-142", url: "https://linear.app/c/CLN-142" } })).error).toBeUndefined();
    const { data } = await call(c, "search_items", { query: "CLN-142" });
    expect(data.items.map((x: { id: string }) => x.id)).toContain(sol);
    expect((await call(c, "get_item", { id: sol })).data.item.tickets).toEqual([expect.objectContaining({ key: "CLN-142" })]);
  });

  it("doesn't let update_item change tickets", async () => {
    expect((await call(c, "update_item", { id: sol, patch: { tickets: [] } })).error).toBeDefined();
  });

  it("reports ticket updates", async () => {
    await call(c, "link_tickets", { requirementIds: [sol], ticket: { tracker: "linear", key: "CLN-142" } });
    const { data } = await call(c, "update_tickets", { tickets: [{ tracker: "linear", key: "CLN-142", state: "Done", done: true }, { tracker: "linear", key: "CLN-999", done: true }] });
    expect(data).toMatchObject({ updated: 1, notLinked: [{ tracker: "linear", key: "CLN-999" }] });
  });
});

describe("reverse-engineered items", () => {
  it("stores codeRefs and the existing-product origin", async () => {
    const c = await connect();
    const req = await call(c, "add_requirements", {
      requirements: [
        {
          kind: "stakeholder",
          title: "Discounts apply to invoices",
          story: "As a finance manager I want discounts applied to invoices so that totals are right.",
          acceptanceCriteria: ["Discount shown on the invoice"],
          origin: "existing-product",
          codeRefs: ["src/billing/invoice.ts#applyDiscount"],
        },
      ],
    });
    expect(req.error).toBeUndefined();
    const hyp = await call(c, "add_hypotheses", {
      hypotheses: [
        {
          title: "Billing is used for volume deals",
          outcome: "keep volume customers",
          forWhom: "finance managers",
          benefit: "predictable invoices",
          feature: "discount rules",
          origin: "inferred",
          codeRefs: ["src/billing"],
        },
      ],
    });
    expect(hyp.error).toBeUndefined();
    const items = load(root).items;
    const r = items.requirements.find((x) => x.id === req.data.created[0].id)!;
    const h = items.hypotheses.find((x) => x.id === hyp.data.created[0].id)!;
    expect(r.origin).toBe("existing-product");
    expect(r.codeRefs).toEqual(["src/billing/invoice.ts#applyDiscount"]);
    expect(h.origin).toBe("inferred");
    expect(h.codeRefs).toEqual(["src/billing"]);
  });
});
