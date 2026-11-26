import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import YAML from "yaml";
import { COLLECTION_KEYS, diffCollections, emptyCollections, type Collections } from "../core/collections";
import { ID_PREFIX, LOCAL_ID, type Kind } from "../core/schemas";
import { DIR } from "./config";
import { loadProducts, type Product } from "./products";

/**
 * Items as files: groundwork/<collection>/<ID>-<slug>.md, YAML frontmatter for the fields, and a Markdown body
 * that is yours. Groundwork keeps the body as `notes` and never rewrites it.
 */

export type ItemCollection = Exclude<keyof Collections, "activity">;

export const COLLECTIONS: Record<Kind, ItemCollection> = {
  insight: "insights",
  hypothesis: "hypotheses",
  experiment: "experiments",
  finding: "findings",
  requirement: "requirements",
  risk: "risks",
};

export const KIND_OF: Record<ItemCollection, Kind> = {
  insights: "insight",
  hypotheses: "hypothesis",
  experiments: "experiment",
  findings: "finding",
  requirements: "requirement",
  risks: "risk",
};

const ITEM_COLLECTIONS = COLLECTION_KEYS.filter((k): k is ItemCollection => k !== "activity");

export interface FileProblem {
  file: string;
  message: string;
}

export interface Loaded {
  items: Collections;
  /** Product files (groundwork/products/). Not part of Collections, which the hosted app shares. */
  products: Product[];
  /** Item id -> file path relative to the project root. */
  paths: Map<string, string>;
  problems: FileProblem[];
}

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "item"
  );
}

/** Where a new item's file goes. */
export function newPath(kind: Kind, id: string, title: string) {
  return `${DIR}/${COLLECTIONS[kind]}/${id}-${slug(title)}.md`;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseItem(text: string): { data: Record<string, unknown>; notes: string } {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("no YAML frontmatter (the file must start with a line of three dashes)");
  const data = YAML.parse(m[1]);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("the frontmatter isn't a set of fields");
  return { data: data as Record<string, unknown>, notes: m[2].replace(/^\r?\n/, "").trimEnd() };
}

/** Drop undefined values, recursively, so they don't show up as `null` in YAML. */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => (x === undefined ? [] : [[k, clean(x)]])));
  }
  return v;
}

export function renderItem(item: Record<string, unknown>): string {
  const { id, title, notes, ...rest } = item;
  const fm = YAML.stringify(clean({ id, title, ...rest }), { lineWidth: 0 });
  const body = typeof notes === "string" && notes.trim() ? `\n${notes.trim()}\n` : "";
  return `---\n${fm}---\n${body}`;
}

export function load(root: string): Loaded {
  const items = emptyCollections();
  const paths = new Map<string, string>();
  const problems: FileProblem[] = [];
  for (const key of ITEM_COLLECTIONS) {
    const dir = join(root, DIR, key);
    if (!existsSync(dir)) continue;
    const prefix = ID_PREFIX[KIND_OF[key]];
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".md")) continue;
      const file = relative(root, join(dir, name));
      try {
        const { data, notes } = parseItem(readFileSync(join(dir, name), "utf8"));
        const id = data.id;
        if (typeof id !== "string" || !LOCAL_ID.test(id)) throw new Error(`id must look like ${prefix}-0001, not ${JSON.stringify(id)}`);
        if (!id.startsWith(`${prefix}-`)) throw new Error(`${id} is in ${key}/, but ${key} ids start with ${prefix}-`);
        if (paths.has(id)) {
          problems.push({ file, message: `duplicate id ${id}, also used by ${paths.get(id)}. Give one of them a new id. If they come from different branches, run: groundwork renumber --against <base branch>` });
          continue;
        }
        paths.set(id, file);
        (items[key] as unknown[]).push(notes ? { ...data, notes } : data);
      } catch (e) {
        problems.push({ file, message: (e as Error).message });
      }
    }
  }
  const prod = loadProducts(root);
  prod.paths.forEach((path, id) => paths.set(id, path));
  return { items, products: prod.products, paths, problems: [...problems, ...prod.problems] };
}

/** The next free id per kind: one more than the highest in use. */
export function idAllocator(items: Collections) {
  const next = new Map<Kind, number>();
  for (const key of ITEM_COLLECTIONS) {
    let max = 0;
    for (const x of items[key] as { id: string }[]) {
      const n = Number(x.id.split("-")[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
    next.set(KIND_OF[key], max + 1);
  }
  return (kind: Kind) => {
    const n = next.get(kind)!;
    next.set(kind, n + 1);
    return `${ID_PREFIX[kind]}-${String(n).padStart(4, "0")}`;
  };
}

export const LINK_FIELDS = ["insightIds", "hypothesisIds", "experimentIds", "findingIds", "stakeholderIds", "obsoletedBy", "replaces"] as const;

/**
 * The operations make new items with temporary ids. Give each a readable id (INS-0008…) in creation order, and
 * point every link at the new ids. Returns the new collections and the temporary -> final id map.
 */
export function assignIds(before: Collections, after: Collections): { items: Collections; renamed: Map<string, string> } {
  const known = new Set(ITEM_COLLECTIONS.flatMap((k) => (before[k] as { id: string }[]).map((x) => x.id)));
  const alloc = idAllocator(before);
  const renamed = new Map<string, string>();
  for (const key of ITEM_COLLECTIONS) {
    // The operations put new items first, newest batch first; within a batch, in the order given.
    for (const x of after[key] as { id: string }[]) if (!known.has(x.id) && !LOCAL_ID.test(x.id)) renamed.set(x.id, alloc(KIND_OF[key]));
  }
  if (!renamed.size) return { items: after, renamed };
  const map = (id: string) => renamed.get(id) ?? id;
  const items = { ...after };
  for (const key of ITEM_COLLECTIONS) {
    (items[key] as unknown[]) = (after[key] as unknown as Record<string, unknown>[]).map((x) => {
      let y = x;
      const touch = () => (y === x ? (y = { ...x }) : y);
      if (renamed.has(x.id as string)) touch().id = map(x.id as string);
      if (typeof x.hypothesisId === "string" && renamed.has(x.hypothesisId)) touch().hypothesisId = map(x.hypothesisId);
      for (const f of LINK_FIELDS) {
        const list = x[f];
        if (Array.isArray(list) && list.some((v) => renamed.has(v))) touch()[f] = list.map(map);
      }
      return y;
    });
  }
  return { items, renamed };
}

/** Equal as data: key order and undefined fields don't matter. */
function sameJSON(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
              .sort()
              .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Write what changed between two snapshots: changed items rewritten, new ones created, removed ones deleted. */
export function save(root: string, loaded: Loaded, after: Collections): string[] {
  const { upserts, deletes } = diffCollections(loaded.items, after);
  const before = new Map(ITEM_COLLECTIONS.flatMap((k) => (loaded.items[k] as { id: string }[]).map((x) => [x.id, x] as const)));
  const touched: string[] = [];
  for (const u of upserts) {
    if (u.kind === "activity") continue; // Git history is the activity log.
    // Cascades copy every item; only rewrite files whose content really changed, so hand formatting survives.
    const old = before.get(u.id);
    if (old && sameJSON(old, { id: u.id, ...u.data })) continue;
    const kind = u.kind as Kind;
    const rel = loaded.paths.get(u.id) ?? newPath(kind, u.id, String(u.data.title ?? ""));
    mkdirSync(join(root, DIR, COLLECTIONS[kind]), { recursive: true });
    writeAtomic(join(root, rel), renderItem({ id: u.id, ...u.data }));
    loaded.paths.set(u.id, rel);
    touched.push(rel);
  }
  for (const id of deletes) {
    const rel = loaded.paths.get(id);
    if (!rel) continue;
    if (existsSync(join(root, rel))) unlinkSync(join(root, rel));
    loaded.paths.delete(id);
    touched.push(rel);
  }
  loaded.items = after;
  return touched;
}
