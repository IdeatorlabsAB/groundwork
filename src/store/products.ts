import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { DIR } from "./config";
import { parseItem, renderItem, slug, type FileProblem } from "./files";

/**
 * Products as files: groundwork/products/PRD-0001-<slug>.md holds one product with its areas and versions.
 * They aren't part of Collections (shared with the hosted app); the catalogue reads them.
 */

export const PRODUCTS_DIR = "products";
export const PRODUCT_PREFIX = "PRD";

export interface ProductVersion {
  version: string;
  status: "planned" | "released";
  plannedFor?: string;
  releasedAt?: string;
  releasedBy?: string;
}

export interface Product {
  id: string;
  title: string;
  areas: { id: string; label: string }[];
  versions: ProductVersion[];
  createdAt?: string;
  notes?: string;
}

const slugId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and dashes");

export const productSchema = z
  .object({
    id: z.string().regex(/^PRD-\d{4,}$/, "a product id looks like PRD-0001"),
    title: z.string().trim().min(1).max(100),
    areas: z.array(z.object({ id: slugId, label: z.string().trim().min(1).max(100) }).loose()).default([]),
    versions: z
      .array(
        z
          .object({
            version: z.string().trim().min(1).max(40),
            status: z.enum(["planned", "released"]).default("planned"),
            plannedFor: z.string().optional(),
            releasedAt: z.string().optional(),
            releasedBy: z.string().optional(),
          })
          .loose(),
      )
      .default([]),
    createdAt: z.string().optional(),
  })
  .loose();

export function loadProducts(root: string): { products: Product[]; paths: Map<string, string>; problems: FileProblem[] } {
  const products: Product[] = [];
  const paths = new Map<string, string>();
  const problems: FileProblem[] = [];
  const dir = join(root, DIR, PRODUCTS_DIR);
  if (!existsSync(dir)) return { products, paths, problems };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    const file = `${DIR}/${PRODUCTS_DIR}/${name}`;
    try {
      const { data, notes } = parseItem(readFileSync(join(dir, name), "utf8"));
      const parsed = productSchema.safeParse(data);
      if (!parsed.success) throw new Error(z.prettifyError(parsed.error).replace(/\n/g, "; "));
      const p = parsed.data as Product;
      if (paths.has(p.id)) {
        problems.push({ file, message: `duplicate id ${p.id}, also used by ${paths.get(p.id)}. If they come from different branches, run: groundwork renumber --against <base branch>` });
        continue;
      }
      paths.set(p.id, file);
      products.push(notes ? { ...p, notes } : p);
    } catch (e) {
      problems.push({ file, message: (e as Error).message });
    }
  }
  return { products, paths, problems };
}

export function nextProductId(products: Product[]): string {
  const max = products.reduce((m, p) => Math.max(m, Number(p.id.split("-")[1]) || 0), 0);
  return `${PRODUCT_PREFIX}-${String(max + 1).padStart(4, "0")}`;
}

const SPLIT = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/;

/**
 * Write a product. A new one gets groundwork/products/<id>-<slug>.md. An existing file (`path`) is edited in place,
 * so comments, unknown keys and the notes body survive. Returns the path relative to the project root.
 */
export function writeProduct(root: string, product: Product, path?: string): string {
  const rel = path ?? `${DIR}/${PRODUCTS_DIR}/${product.id}-${slug(product.title)}.md`;
  const abs = join(root, rel);
  mkdirSync(join(root, DIR, PRODUCTS_DIR), { recursive: true });
  const { notes, ...fields } = product;
  let text: string;
  const m = existsSync(abs) ? SPLIT.exec(readFileSync(abs, "utf8")) : null;
  if (m) {
    const doc = YAML.parseDocument(m[2]);
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && JSON.stringify(doc.toJS()?.[k]) !== JSON.stringify(v)) doc.set(k, doc.createNode(v));
    text = `${m[1]}${doc.toString({ lineWidth: 0 }).replace(/\r?\n$/, "")}${m[3]}${m[4]}`;
  } else {
    text = renderItem({ ...fields, createdAt: fields.createdAt ?? new Date().toISOString(), notes });
  }
  const tmp = `${abs}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, abs);
  return rel;
}
