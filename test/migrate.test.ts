import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/store/config";
import { load, parseItem } from "../src/store/files";
import { migrate, planMigration } from "../src/store/migrate";
import { validate } from "../src/store/validate";
import { writeProduct } from "../src/store/products";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gw-migrate-"));
  cpSync(join(__dirname, "../examples/acme/groundwork"), join(root, "groundwork"), { recursive: true });
  // Start from the example as it was before migrating: flat lists, schema 1, requirements naming "Acme app".
  writeFileSync(
    join(root, "groundwork/config.yml"),
    "# Groundwork settings. See SPEC.md for every field.\nschemaVersion: 1\nname: Acme\nproductAreas:\n  - id: onboarding\n    label: Onboarding\n  - id: reporting\n    label: Reporting\nproducts:\n  - Acme app\npeople:\n  - id: sam\n    name: Sam\n    role: owner\n",
  );
  rmSync(join(root, "groundwork/products"), { recursive: true, force: true });
  // Risks came after products moved to files (they need a product file), so the older example has none.
  rmSync(join(root, "groundwork/risks"), { recursive: true, force: true });
  for (const name of readdirSync(join(root, "groundwork/requirements"))) {
    const file = join(root, "groundwork/requirements", name);
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replace(/^product: PRD-0001$/m, "product: Acme app")
        .replace(/^(plannedFor|releasedIn|releasedAt|releasedBy): .*\n/gm, "")
        .replace(/^riskIds:\n(  - .*\n)+/m, ""),
    );
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length)] = createHash("sha1").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

const REQ = "groundwork/requirements/REQ-0002-guided-csv-import.md";

describe("groundwork migrate", () => {
  it("plans without changing any file", () => {
    const before = snapshot(root);
    const plan = planMigration(root)!;
    expect(plan.products.map((p) => [p.id, p.title, p.areas.map((a) => a.id)])).toEqual([["PRD-0001", "Acme app", ["onboarding", "reporting"]]]);
    expect(plan.requirementProducts).toContainEqual({ file: REQ, from: "Acme app", to: "PRD-0001" });
    expect(snapshot(root)).toEqual(before);
  });

  it("moves products and areas into a product file and points requirements at it", () => {
    migrate(root);
    expect(readdirSync(join(root, "groundwork/products"))).toEqual(["PRD-0001-acme-app.md"]);
    expect(load(root).products[0].areas.map((a) => a.id)).toEqual(["onboarding", "reporting"]);
    expect(parseItem(readFileSync(join(root, REQ), "utf8")).data.product).toBe("PRD-0001");
    const config = readConfig(root);
    expect(config).toMatchObject({ schemaVersion: 2, productAreas: [], products: [], name: "Acme" });
    const text = readFileSync(join(root, "groundwork/config.yml"), "utf8");
    expect(text).toContain("# Groundwork settings.");
    expect(text).not.toMatch(/productAreas|products:/);
    expect(validate(load(root), config).filter((p) => p.level === "error")).toEqual([]);
  });

  it("does nothing the second time", () => {
    migrate(root);
    expect(migrate(root)).toBeUndefined();
  });

  it("creates every product and says where the areas went", () => {
    const file = join(root, "groundwork/config.yml");
    writeFileSync(file, readFileSync(file, "utf8").replace("  - Acme app\n", "  - Acme app\n  - Acme API\n"));
    const plan = migrate(root)!;
    expect(plan.products.map((p) => p.title)).toEqual(["Acme app", "Acme API"]);
    expect(plan.notes).toContain("All areas went to Acme app. Move any that belong to another product by editing the product files.");
  });

  it("leaves an unknown product on a requirement alone and reports it", () => {
    writeFileSync(join(root, REQ), readFileSync(join(root, REQ), "utf8").replace("product: Acme app", "product: Old name"));
    const before = readFileSync(join(root, REQ), "utf8");
    const plan = migrate(root)!;
    expect(plan.unknownProducts).toEqual([{ file: REQ, value: "Old name" }]);
    expect(readFileSync(join(root, REQ), "utf8")).toBe(before);
  });
});

describe("groundwork migrate finishes a partial or older project", () => {
  it("finishes a migration that stopped half-way", () => {
    migrate(root);
    const file = join(root, "groundwork/config.yml");
    writeFileSync(file, readFileSync(file, "utf8") + "products:\n  - Acme app\n");
    writeFileSync(join(root, REQ), readFileSync(join(root, REQ), "utf8").replace("product: PRD-0001", "product: Acme app"));
    const plan = migrate(root)!;
    expect(plan.requirementProducts).toEqual([{ file: REQ, from: "Acme app", to: "PRD-0001" }]);
    expect(parseItem(readFileSync(join(root, REQ), "utf8")).data.product).toBe("PRD-0001");
    expect(readFileSync(file, "utf8")).not.toMatch(/products:/);
    expect(validate(load(root), readConfig(root)).filter((p) => p.level === "error")).toEqual([]);
  });

  it("points an older project's free-text products at product files added later", () => {
    const file = join(root, "groundwork/config.yml");
    writeFileSync(file, "schemaVersion: 1\nname: Acme\npeople: []\n");
    writeProduct(root, { id: "PRD-0001", title: "Acme app", areas: [{ id: "onboarding", label: "Onboarding" }, { id: "reporting", label: "Reporting" }], versions: [] });
    expect(migrate(root)!.requirementProducts).toContainEqual({ file: REQ, from: "Acme app", to: "PRD-0001" });
    expect(validate(load(root), readConfig(root)).filter((p) => p.level === "error")).toEqual([]);
  });

  it("changes no file the second time", () => {
    migrate(root);
    const before = snapshot(root);
    expect(migrate(root)).toBeUndefined();
    expect(snapshot(root)).toEqual(before);
  });
});
