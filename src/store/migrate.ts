import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { catalogueOf } from "./catalogue";
import { configPath, readConfig } from "./config";
import { load, save } from "./files";
import { writeProduct, type Product } from "./products";

/**
 * `groundwork migrate`: move a project from config.yml's flat productAreas / products lists to product files
 * (groundwork/products/), point requirements at product ids, and set schemaVersion 2. Never runs implicitly.
 */

export interface MigrationPlan {
  products: Product[];
  requirementProducts: { file: string; from: string; to: string }[];
  unknownProducts: { file: string; value: string }[];
  notes: string[];
}

/** What migrating would do, or undefined when there's nothing to migrate. Changes nothing. */
export function planMigration(root: string): MigrationPlan | undefined {
  const config = readConfig(root);
  const loaded = load(root);
  if (!catalogueOf(config, loaded.products).legacy) return undefined;

  const titles = config.products.length ? config.products : [config.name];
  const products: Product[] = titles.map((title, i) => ({
    id: `PRD-${String(i + 1).padStart(4, "0")}`,
    title,
    areas: i === 0 ? config.productAreas.map(({ id, label }) => ({ id, label })) : [],
    versions: [],
  }));
  const notes: string[] = [];
  if (titles.length > 1 && config.productAreas.length) {
    notes.push(`All areas went to ${titles[0]}. Move any that belong to another product by editing the product files.`);
  }

  const requirementProducts: MigrationPlan["requirementProducts"] = [];
  const unknownProducts: MigrationPlan["unknownProducts"] = [];
  for (const r of loaded.items.requirements) {
    if (!r.product) continue;
    const file = loaded.paths.get(r.id) ?? r.id;
    const p = products.find((x) => x.title.trim().toLowerCase() === r.product!.trim().toLowerCase());
    if (p) requirementProducts.push({ file, from: r.product, to: p.id });
    else unknownProducts.push({ file, value: r.product });
  }
  return { products, requirementProducts, unknownProducts, notes };
}

/** Apply the migration. Returns what was done, or undefined when there was nothing to migrate. */
export function migrate(root: string): MigrationPlan | undefined {
  const plan = planMigration(root);
  if (!plan) return undefined;
  for (const p of plan.products) writeProduct(root, p);

  const loaded = load(root);
  const to = new Map(plan.requirementProducts.map((x) => [x.file, x.to]));
  const requirements = loaded.items.requirements.map((r) => {
    const id = to.get(loaded.paths.get(r.id) ?? "");
    return id ? { ...r, product: id } : r;
  });
  save(root, loaded, { ...loaded.items, requirements });

  // Edit config.yml in place, so comments and other keys are kept.
  const file = configPath(root);
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  doc.delete("productAreas");
  doc.delete("products");
  doc.set("schemaVersion", 2);
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  return plan;
}
