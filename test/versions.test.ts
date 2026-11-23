import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogueOf, isVersioned, plannedVersions, productOf } from "../src/store/catalogue";
import { readConfig, writeConfig } from "../src/store/config";
import { load, renderItem } from "../src/store/files";
import { writeProduct, type Product } from "../src/store/products";
import { validate } from "../src/store/validate";

let root: string;
const CLINICARE: Product = {
  id: "PRD-0001",
  title: "Clinicare Web Application",
  areas: [{ id: "scheduling", label: "Scheduling" }],
  versions: [
    { version: "1.0", status: "released", releasedAt: "2026-10-01T00:00:00.000Z", releasedBy: "sam" },
    { version: "1.1", status: "planned" },
  ],
};

const REQS = "groundwork/requirements";
const base = { acceptanceCriteria: ["a"], priority: "must", findingIds: [], createdAt: "2026-11-01T00:00:00.000Z" };
const write = (name: string, data: Record<string, unknown>) => writeFileSync(join(root, REQS, name), renderItem(data));
const stakeholder = (extra: Record<string, unknown> = {}) =>
  write("REQ-0001-book.md", { id: "REQ-0001", title: "Book", kind: "stakeholder", story: "As a secretary I want slots so that I can book.", status: "draft", ...base, ...extra });
const solution = (extra: Record<string, unknown> = {}) =>
  write("REQ-0002-slots.md", {
    id: "REQ-0002",
    title: "Slots",
    kind: "solution",
    story: "The booking view shall show free slots.",
    stakeholderIds: ["REQ-0001"],
    product: "PRD-0001",
    status: "draft",
    ...base,
    ...extra,
  });
const messages = () => validate(load(root), readConfig(root)).map((p) => `${p.level}: ${p.message}`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gw-versions-"));
  writeConfig(root, { schemaVersion: 2, name: "Clinicare", productAreas: [], products: [], people: [{ id: "sam", name: "Sam", role: "owner" }] });
  writeProduct(root, CLINICARE);
  mkdirSync(join(root, REQS), { recursive: true });
  stakeholder();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("productOf", () => {
  it("uses the requirement's product, or the only product", () => {
    const c = catalogueOf(readConfig(root), load(root).products);
    expect(productOf(c, { product: "PRD-0001" })?.id).toBe("PRD-0001");
    expect(productOf(c, {})?.id).toBe("PRD-0001");
    expect(isVersioned(c, {})).toBe(true);
    expect(plannedVersions(CLINICARE)).toEqual(["1.1"]);
  });

  it("returns nothing for a requirement without a product when there are several", () => {
    writeProduct(root, { id: "PRD-0002", title: "Clinicare Mobile", areas: [], versions: [] });
    const c = catalogueOf(readConfig(root), load(root).products);
    expect(productOf(c, {})).toBeUndefined();
  });
});

describe("validate requirement versions", () => {
  it("errors on an approved solution requirement with no planned version", () => {
    solution({ status: "approved", approvedBy: "sam", approver: "sam" });
    expect(messages()).toContain("error: approved but not planned for a version of Clinicare Web Application: plan it with plan_requirements");
  });

  it("errors on a version the product doesn't have", () => {
    solution({ status: "approved", plannedFor: "9.9", obsoletePlannedFor: "8.8" });
    expect(messages()).toContain('error: plannedFor "9.9" isn\'t a version of Clinicare Web Application');
    expect(messages()).toContain('error: obsoletePlannedFor "8.8" isn\'t a version of Clinicare Web Application');
  });

  it("errors on releasedIn pointing at a planned version", () => {
    solution({ status: "approved", plannedFor: "1.1", releasedIn: "1.1" });
    expect(messages()).toContain('error: releasedIn "1.1" isn\'t released yet');
  });

  it("errors on versions on a stakeholder requirement", () => {
    stakeholder({ plannedFor: "1.1" });
    expect(messages()).toContain("error: only solution requirements are planned for versions");
  });

  it("warns when planned for a released version but not released in it", () => {
    solution({ status: "approved", plannedFor: "1.0" });
    expect(messages()).toContain("warning: planned for 1.0, which is released, but not released in it");
  });

  it("checks replaces links", () => {
    solution({ replaces: ["REQ-0042"] });
    expect(messages()).toContain("error: replaces: REQ-0042 doesn't exist");
  });

  it("has no version errors when the product has no versions", () => {
    writeProduct(root, { ...CLINICARE, versions: [] }, load(root).paths.get("PRD-0001"));
    solution({ status: "approved", approvedBy: "sam", approver: "sam" });
    expect(messages().filter((m) => m.startsWith("error"))).toEqual([]);
  });
});

describe("validate obsolete and released requirements", () => {
  it("errors on obsoletedIn naming a version that isn't released", () => {
    solution({ status: "obsolete", obsoletedIn: "1.1" });
    expect(messages()).toContain('error: obsoletedIn "1.1" isn\'t released yet');
  });

  it("warns when a requirement was made obsolete but its replacement hasn't shipped", () => {
    solution({ status: "obsolete", obsoletedIn: "1.0", obsoletedBy: ["REQ-0003"] });
    write("REQ-0003-new.md", { id: "REQ-0003", title: "New", kind: "solution", story: "The view shall x.", stakeholderIds: ["REQ-0001"], product: "PRD-0001", status: "approved", plannedFor: "1.1", ...base });
    expect(messages()).toContain("warning: obsolete in 1.0, but REQ-0003 that replaces it hasn't shipped");
  });

  it("warns when obsolescence is planned for a version that's already released", () => {
    solution({ status: "approved", releasedIn: "1.0", releasedAt: "x", releasedBy: "sam", obsoletePlannedFor: "1.0" });
    expect(messages()).toContain("warning: planned to become obsolete in 1.0, which is already released");
  });

  it("warns when a release is missing who and when", () => {
    solution({ status: "approved", releasedIn: "1.0" });
    expect(messages()).toContain("warning: released in 1.0 without releasedAt and releasedBy");
  });
});

describe("validate tickets from hand edits", () => {
  it("reports a ticket whose key isn't text, instead of breaking", () => {
    solution({ tickets: [{ tracker: "github", key: 57, linkedAt: "x", linkedBy: "sam" }] });
    expect(messages()).toContain("error: a ticket needs a tracker and a key, as text");
  });

  it("reports tickets that aren't a list", () => {
    solution({ tickets: { tracker: "github", key: "57" } });
    expect(messages()).toContain("error: tickets must be a list");
  });
});
