/**
 * Adding product areas and products to a workspace. Add-only: existing entries are never removed, renamed or
 * reordered, so items tagged with them stay valid.
 */

export interface AreaEntry {
  id: string;
  label: string;
}

export class WorkspaceError extends Error {}

/** Same rule as config.yml's area ids. */
const SLUG_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function mergeAreas(
  existing: AreaEntry[],
  input: { label: string; id?: string }[],
): { list: AreaEntry[]; added: AreaEntry[]; alreadyThere: AreaEntry[] } {
  const list = [...existing];
  const added: AreaEntry[] = [];
  const alreadyThere: AreaEntry[] = [];
  for (const raw of input) {
    const label = raw.label.trim();
    const given = raw.id?.trim();
    const id = given ?? slugify(label);
    if (!id) throw new WorkspaceError(`"${label}" has no letters or digits to make an id from. Give an id (lowercase letters, digits and dashes).`);
    if (!SLUG_ID.test(id)) throw new WorkspaceError(`"${id}" isn't a valid area id: use up to 40 lowercase letters, digits and dashes, starting with a letter or digit.`);
    const byLabel = list.find((a) => same(a.label, label));
    if (byLabel) {
      alreadyThere.push(byLabel);
      continue;
    }
    const byId = list.find((a) => a.id === id);
    if (byId) throw new WorkspaceError(`"${label}" would get the id "${id}", which "${byId.label}" already uses. Give a different id.`);
    const area = { id, label };
    list.push(area);
    added.push(area);
  }
  return { list, added, alreadyThere };
}

export function mergeProducts(existing: string[], input: string[]): { list: string[]; added: string[]; alreadyThere: string[] } {
  const list = [...existing];
  const added: string[] = [];
  const alreadyThere: string[] = [];
  for (const raw of input) {
    const name = raw.trim();
    if (!name) throw new WorkspaceError("A product name can't be empty.");
    const hit = list.find((p) => same(p, name));
    if (hit) {
      alreadyThere.push(hit);
      continue;
    }
    list.push(name);
    added.push(name);
  }
  return { list, added, alreadyThere };
}
