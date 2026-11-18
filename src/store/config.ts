import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";

/** The folder inside a project that holds everything Groundwork writes. */
export const DIR = "groundwork";
export const CONFIG_FILE = "config.yml";
export const SCHEMA_VERSION = 1;

const slugId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and dashes");

export const configSchema = z.object({
  schemaVersion: z.number().int().positive().default(SCHEMA_VERSION),
  name: z.string().trim().min(1).max(100),
  productAreas: z.array(z.object({ id: slugId, label: z.string().trim().min(1).max(100) })).default([]),
  products: z.array(z.string().trim().min(1).max(100)).default([]),
  people: z
    .array(
      z.object({
        id: slugId,
        name: z.string().trim().min(1).max(100),
        role: z.enum(["owner", "editor", "viewer"]).default("editor"),
        /** Optional: lets Groundwork recognise you from `git config user.email`. */
        email: z.string().trim().max(200).optional(),
      }),
    )
    .default([]),
  /** Set when this folder was imported into the Groundwork web app. Local writes stop, so the two can't drift apart. */
  migrated: z.string().url().optional(),
});

export type Config = z.infer<typeof configSchema>;
export type Person = Config["people"][number];

/**
 * Where the project is: $GROUNDWORK_DIR, else the nearest folder above the working directory that has a
 * groundwork/config.yml, else the working directory itself (a new project).
 */
export function findRoot(cwd = process.cwd()): string {
  if (process.env.GROUNDWORK_DIR) return resolve(process.env.GROUNDWORK_DIR);
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, DIR, CONFIG_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

export const configPath = (root: string) => join(root, DIR, CONFIG_FILE);
export const isInitialized = (root: string) => existsSync(configPath(root));

export function defaultConfig(root: string): Config {
  return configSchema.parse({ name: basename(resolve(root)) || "Product" });
}

export class ConfigError extends Error {}

export function readConfig(root: string): Config {
  const file = configPath(root);
  if (!existsSync(file)) return defaultConfig(root);
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    throw new ConfigError(`${DIR}/${CONFIG_FILE} isn't valid YAML: ${(e as Error).message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`${DIR}/${CONFIG_FILE} is invalid: ${z.prettifyError(parsed.error)}`);
  if (parsed.data.schemaVersion > SCHEMA_VERSION) {
    throw new ConfigError(`${DIR}/${CONFIG_FILE} uses schema version ${parsed.data.schemaVersion}; this Groundwork understands up to ${SCHEMA_VERSION}. Update groundwork-mcp.`);
  }
  return parsed.data;
}

const CONFIG_HEADER = `# Groundwork settings. See SPEC.md in the groundwork-mcp package for every field.
# productAreas: [{ id: onboarding, label: Onboarding }]
# products: [Acme app]
# people: [{ id: sam, name: Sam, role: owner }]   # roles: owner, editor, viewer
`;

export function writeConfig(root: string, config: Config) {
  mkdirSync(join(root, DIR), { recursive: true });
  writeFileSync(configPath(root), CONFIG_HEADER + YAML.stringify(config, { lineWidth: 0 }));
}

/**
 * Append product areas and products to an existing config.yml, editing the YAML in place so the user's comments,
 * unknown keys and formatting are kept.
 */
export function appendToConfig(root: string, add: { productAreas?: { id: string; label: string }[]; products?: string[] }) {
  const file = configPath(root);
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  for (const key of ["productAreas", "products"] as const) {
    const values = add[key];
    if (!values?.length) continue;
    if (!YAML.isSeq(doc.get(key))) doc.set(key, doc.createNode([]));
    const seq = doc.get(key) as YAML.YAMLSeq;
    for (const v of values) seq.add(doc.createNode(v));
  }
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
}

function gitEmail(root: string): string | undefined {
  try {
    return execFileSync("git", ["config", "user.email"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who is acting: $GROUNDWORK_USER (a person id), else the person whose email matches git's, else the only person
 * listed. Unknown people act as "me", which is fine for a one-person folder.
 */
export function resolveActor(root: string, config: Config): { id: string; person?: Person } {
  const byId = (id: string) => config.people.find((p) => p.id === id);
  const env = process.env.GROUNDWORK_USER?.trim();
  if (env) return { id: env, person: byId(env) };
  const email = gitEmail(root)?.toLowerCase();
  const match = email && config.people.find((p) => p.email?.toLowerCase() === email);
  if (match) return { id: match.id, person: match };
  if (config.people.length === 1) return { id: config.people[0].id, person: config.people[0] };
  return { id: "me" };
}
