import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { DIR } from "./config";
import { COLLECTIONS, LINK_FIELDS, parseItem } from "./files";
import type { Problem } from "./validate";

/**
 * Ids across branches. Everyone works on their own clone, and new items are numbered "highest + 1" there, so two
 * branches can both create REQ-0012. A file's name never changes once it's created, so the same id at a different
 * path is a different item: that's a clash.
 */

export class GitError extends Error {}

export interface ItemFile {
  id: string;
  /** Relative to the project root, e.g. groundwork/requirements/REQ-0012-x.md */
  path: string;
  data: Record<string, unknown>;
  text: string;
}

export interface Clash {
  id: string;
  /** The branch's item. */
  path: string;
  /** The different item on the base with the same id. */
  basePath: string;
}

const FOLDERS = new Set(Object.values(COLLECTIONS));
const isItemPath = (path: string) => {
  const parts = path.split("/");
  return parts.length === 3 && parts[0] === DIR && FOLDERS.has(parts[1] as never) && parts[2].endsWith(".md");
};

function git(root: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, { cwd: root, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

function checkRef(root: string, ref: string) {
  try {
    git(root, ["rev-parse", "--git-dir"]);
  } catch {
    throw new GitError(`Not a git repository: ${root}`);
  }
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    throw new GitError(`Unknown branch or commit "${ref}". Fetch it first, e.g. git fetch origin.`);
  }
}

function toItem(path: string, text: string): ItemFile | undefined {
  try {
    const { data } = parseItem(text);
    return typeof data.id === "string" ? { id: data.id, path, data, text } : undefined;
  } catch {
    return undefined; // validate reports unreadable files
  }
}

/** Item files under groundwork/<collection>/ at a branch or commit. */
export function itemsAt(root: string, ref: string): ItemFile[] {
  checkRef(root, ref);
  const paths = git(root, ["ls-tree", "-r", "--name-only", ref, "--", `${DIR}/`])
    .toString("utf8")
    .split("\n")
    .filter(isItemPath);
  if (!paths.length) return [];
  // One `git cat-file --batch` call: each object comes back as "<sha> blob <size>\n<bytes>\n".
  const out = git(root, ["cat-file", "--batch"], paths.map((p) => `${ref}:${p}`).join("\n") + "\n");
  const items: ItemFile[] = [];
  let at = 0;
  for (const path of paths) {
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol).toString("utf8");
    at = eol + 1;
    const m = /^\S+ blob (\d+)$/.exec(header);
    if (!m) continue;
    const size = Number(m[1]);
    const item = toItem(path, out.subarray(at, at + size).toString("utf8"));
    at += size + 1;
    if (item) items.push(item);
  }
  return items;
}

/** Every readable item file on disk. Unlike load(), files with a duplicate id are all kept. */
export function itemsInWorkingTree(root: string): ItemFile[] {
  const items: ItemFile[] = [];
  for (const folder of FOLDERS) {
    const dir = join(root, DIR, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".md")) continue;
      const path = `${DIR}/${folder}/${name}`;
      const item = toItem(path, readFileSync(join(root, path), "utf8"));
      if (item) items.push(item);
    }
  }
  return items;
}

/** Working-tree items whose id is used by a different item (a different file) at `ref`. */
export function findClashes(root: string, ref: string): Clash[] {
  const base = new Map<string, string>();
  for (const x of itemsAt(root, ref)) if (!base.has(x.id)) base.set(x.id, x.path);
  return itemsInWorkingTree(root)
    .filter((x) => base.has(x.id) && base.get(x.id) !== x.path)
    .map((x) => ({ id: x.id, path: x.path, basePath: base.get(x.id)! }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function clashProblems(root: string, ref: string): Problem[] {
  return findClashes(root, ref).map((c) => ({
    level: "error" as const,
    file: c.path,
    message: `${c.id} is also used by ${c.basePath} on ${ref}. Run: groundwork renumber --against ${ref}`,
  }));
}

export interface Renumbered {
  from: string;
  to: string;
  oldPath: string;
  newPath: string;
}

const SPLIT = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/;
const ID = /^([A-Z]+)-(\d+)$/;

/** Rewrite ids in a file's frontmatter, editing the YAML in place so comments and layout survive. Never the body. */
function rewriteFrontmatter(text: string, map: Map<string, string>): string {
  const m = SPLIT.exec(text);
  if (!m) return text;
  const doc = YAML.parseDocument(m[2]);
  let changed = false;
  for (const field of ["id", "hypothesisId"]) {
    const v = doc.get(field);
    if (typeof v === "string" && map.has(v)) {
      doc.set(field, map.get(v));
      changed = true;
    }
  }
  for (const field of LINK_FIELDS) {
    const seq = doc.get(field);
    if (!YAML.isSeq(seq)) continue;
    for (const node of seq.items) {
      if (YAML.isScalar(node) && typeof node.value === "string" && map.has(node.value)) {
        node.value = map.get(node.value)!;
        changed = true;
      }
    }
  }
  return changed ? `${m[1]}${doc.toString({ lineWidth: 0 }).replace(/\r?\n$/, "")}${m[3]}${m[4]}` : text;
}

/**
 * Give the branch's items that clash with `ref` the next free ids. Their files are renamed (the slug stays), and
 * links to them are rewritten in the files this branch added or changed. Ids on `ref` never change, and Markdown
 * bodies are never rewritten: mentions there are reported instead.
 */
export function renumber(root: string, ref: string): { renumbered: Renumbered[]; rewritten: string[]; mentions: { file: string; id: string }[] } {
  const clashes = findClashes(root, ref);
  if (!clashes.length) return { renumbered: [], rewritten: [], mentions: [] };
  const base = itemsAt(root, ref);
  const work = itemsInWorkingTree(root);

  const next = new Map<string, number>();
  for (const x of [...base, ...work]) {
    const m = ID.exec(x.id);
    if (m) next.set(m[1], Math.max(next.get(m[1]) ?? 1, Number(m[2]) + 1));
  }
  const renumbered: Renumbered[] = [];
  const map = new Map<string, string>();
  const byPath = new Map<string, Renumbered>();
  for (const c of clashes) {
    const prefix = ID.exec(c.id)![1];
    const n = next.get(prefix)!;
    next.set(prefix, n + 1);
    const to = `${prefix}-${String(n).padStart(4, "0")}`;
    const dir = c.path.slice(0, c.path.lastIndexOf("/") + 1);
    const name = c.path.slice(dir.length).replace(/^[A-Z]+-\d+/, to);
    const r = { from: c.id, to, oldPath: c.path, newPath: dir + name };
    renumbered.push(r);
    byPath.set(c.path, r);
    if (!map.has(c.id)) map.set(c.id, to);
  }

  const baseText = new Map(base.map((x) => [x.path, x.text]));
  const changed = work.filter((x) => baseText.get(x.path) !== x.text);
  const rewritten: string[] = [];
  const mentions: { file: string; id: string }[] = [];
  for (const x of changed) {
    const target = byPath.get(x.path)?.newPath ?? x.path;
    const text = rewriteFrontmatter(x.text, map);
    if (text !== x.text || target !== x.path) {
      writeFileSync(join(root, target), text);
      if (target !== x.path) unlinkSync(join(root, x.path));
      if (text !== x.text) rewritten.push(target);
    }
    const body = SPLIT.exec(x.text)?.[4] ?? "";
    for (const from of map.keys()) if (new RegExp(`\\b${from}\\b`).test(body)) mentions.push({ file: target, id: from });
  }
  return { renumbered, rewritten, mentions };
}
