import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogueOf, findArea, findProduct } from "../src/store/catalogue";
import { readConfig, writeConfig } from "../src/store/config";
import { load, renderItem } from "../src/store/files";
import { validate } from "../src/store/validate";
import { nextProductId, writeProduct } from "../src/store/products";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gw-catalogue-"));
  writeConfig(root, { schemaVersion: 2, name: "Clinicare", productAreas: [], products: [], people: [] });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("product files and the catalogue", () => {
  it("loads product files into the catalogue", () => {
    writeProduct(root, {
      id: "PRD-0001",
      title: "Clinicare Web Application",
      areas: [{ id: "scheduling", label: "Scheduling" }],
      versions: [{ version: "1.0", status: "planned" }],
    });
    const c = catalogueOf(readConfig(root), load(root).products);
    expect(c.legacy).toBe(false);
    expect(c.areas).toEqual([{ id: "scheduling", label: "Scheduling", productId: "PRD-0001" }]);
    expect(findProduct(c, "clinicare web application")?.id).toBe("PRD-0001");
    expect(findArea(c, "SCHEDULING")?.productId).toBe("PRD-0001");
  });

  it("treats flat config lists without product files as a legacy catalogue", () => {
    writeConfig(root, { ...readConfig(root), productAreas: [{ id: "onboarding", label: "Onboarding" }], products: ["Acme app"] });
    const c = catalogueOf(readConfig(root), load(root).products);
    expect(c).toMatchObject({ legacy: true, productNames: ["Acme app"], areas: [{ id: "onboarding", label: "Onboarding" }] });
  });

  it("keeps notes and comments when a product file is rewritten", () => {
    const path = writeProduct(root, { id: "PRD-0001", title: "Clinicare", areas: [], versions: [] });
    writeFileSync(join(root, path), readFileSync(join(root, path), "utf8").replace("---\n", "---\n# ours\n") + "\nRoadmap notes.\n");
    writeProduct(root, { ...load(root).products[0], versions: [{ version: "1.0", status: "planned" }] }, path);
    const text = readFileSync(join(root, path), "utf8");
    expect(text).toContain("# ours");
    expect(text).toContain("Roadmap notes.");
    expect(load(root).products[0].versions).toEqual([{ version: "1.0", status: "planned" }]);
  });

  it("reads schemaVersion 1 and 2, and refuses 3", () => {
    writeConfig(root, { ...readConfig(root), schemaVersion: 2 });
    expect(readConfig(root).schemaVersion).toBe(2);
    writeConfig(root, { ...readConfig(root), schemaVersion: 3 });
    expect(() => readConfig(root)).toThrow(/understands up to 2/);
  });

  it("numbers new products after the highest", () => {
    expect(nextProductId([{ id: "PRD-0002", title: "x", areas: [], versions: [] }])).toBe("PRD-0003");
  });
});

describe("validate with product files", () => {
  const messages = () => validate(load(root), readConfig(root)).map((p) => `${p.level}: ${p.message}`);
  const clinicare = { id: "PRD-0001", title: "Clinicare Web Application", areas: [{ id: "scheduling", label: "Scheduling" }], versions: [] };

  it("errors when two products define the same area id", () => {
    writeProduct(root, clinicare);
    writeProduct(root, { id: "PRD-0002", title: "Clinicare App", areas: [{ id: "scheduling", label: "Scheduling" }], versions: [] });
    expect(messages()).toContain('error: productArea "scheduling" is defined by both PRD-0001 and PRD-0002');
  });

  it("errors when a version is listed twice", () => {
    writeProduct(root, { ...clinicare, versions: [{ version: "1.0", status: "planned" }, { version: "1.0", status: "planned" }] });
    expect(messages()).toContain('error: version "1.0" is listed twice');
  });

  it("errors when a requirement names a product by title, and says to use the id", () => {
    writeProduct(root, clinicare);
    mkdirSync(join(root, "groundwork/requirements"), { recursive: true });
    writeFileSync(
      join(root, "groundwork/requirements/REQ-0001-need.md"),
      renderItem({ id: "REQ-0001", title: "Need", kind: "stakeholder", story: "As a nurse I want x so that y.", acceptanceCriteria: ["a"], priority: "must", status: "draft", findingIds: [], createdAt: "x" }),
    );
    writeFileSync(
      join(root, "groundwork/requirements/REQ-0002-slots.md"),
      renderItem({ id: "REQ-0002", title: "Slots", kind: "solution", story: "The system shall show slots.", stakeholderIds: ["REQ-0001"], product: "Clinicare Web Application", acceptanceCriteria: ["a"], priority: "must", status: "draft", findingIds: [], createdAt: "x" }),
    );
    expect(messages()).toContain("error: use the product id PRD-0001 instead of its title (groundwork migrate fixes this)");
  });

  it("warns that flat config lists are ignored once product files exist", () => {
    writeProduct(root, clinicare);
    writeConfig(root, { ...readConfig(root), productAreas: [{ id: "onboarding", label: "Onboarding" }] });
    expect(messages()).toContain("warning: config.yml productAreas/products are ignored: products live in groundwork/products/");
  });
});

describe("a new config.yml", () => {
  it("doesn't steer people to the old flat lists", () => {
    const fresh = mkdtempSync(join(tmpdir(), "gw-fresh-"));
    writeConfig(fresh, readConfig(fresh));
    const text = readFileSync(join(fresh, "groundwork/config.yml"), "utf8");
    rmSync(fresh, { recursive: true, force: true });
    expect(text).toContain("schemaVersion: 2");
    expect(text).not.toMatch(/productAreas|^products:/m);
    expect(text).toContain("groundwork/products/");
  });
});
