#!/usr/bin/env node
import { parseArgs } from "node:util";
import { KIND, type Kind } from "./core/schemas";
import type { Requirement } from "./core/types";
import { kindOf } from "./core/requirements";
import { ConfigError, DIR, findRoot, isInitialized, readConfig, writeConfig } from "./store/config";
import { COLLECTIONS, load, type Loaded } from "./store/files";
import { validate } from "./store/validate";
import { clashProblems, GitError, renumber } from "./store/branches";
import { outgoing } from "./mcp/server";
import { runMcp } from "./mcp/run";
import { ImportError, runImport } from "./store/import";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

const HELP = `groundwork ${VERSION}: product evidence as linked files in your repo

Usage:
  groundwork init [--name <product>]   Create groundwork/config.yml in this folder
  groundwork validate [--json] [--against <base>]
                                       Check every item and link; with --against, also ids that
                                       clash with <base>. Exits 1 on errors (use it in CI)
  groundwork renumber --against <base>
                                       Give this branch's items that clash with <base> new ids,
                                       and fix links
  groundwork trace <ID>                Show the evidence chain behind an item, e.g. REQ-0003
  groundwork list [kind]               List items, optionally only one kind
  groundwork import --to <web app url> Move this project into the Groundwork web app
                    [--dry-run] [--overwrite]   (token from $GROUNDWORK_TOKEN)
  groundwork mcp                       Run the MCP server over stdio (same as groundwork-mcp)

Connect your agent:
  claude mcp add groundwork -- npx -y groundwork-mcp   (Claude Code)
  codex mcp add groundwork -- npx -y groundwork-mcp    (Codex)
`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint(2);
const red = paint(31);
const yellow = paint(33);
const green = paint(32);
const bold = paint(1);

type Item = { id: string; title: string; status?: string; verdict?: string };

function index(loaded: Loaded) {
  const byId = new Map<string, { kind: Kind; item: Item }>();
  for (const kind of KIND.options) for (const item of loaded.items[COLLECTIONS[kind]] as Item[]) byId.set(item.id, { kind, item });
  return byId;
}

function label(kind: Kind, item: Item) {
  const tags = [
    kind === "requirement" ? kindOf(item as unknown as Requirement) : undefined,
    item.status,
    item.verdict && item.verdict !== item.status ? item.verdict : undefined,
  ].filter(Boolean);
  return `${bold(item.id)} ${item.title}${tags.length ? dim(` (${tags.join(", ")})`) : ""}`;
}

function cmdInit(name?: string) {
  const root = process.cwd();
  if (isInitialized(root)) {
    console.log(`${DIR}/config.yml already exists.`);
    return 0;
  }
  const config = readConfig(root);
  writeConfig(root, name ? { ...config, name } : config);
  console.log(`Created ${DIR}/config.yml. Add your product areas, products and people there.`);
  console.log(`\nConnect your agent:`);
  console.log(`  claude mcp add groundwork -- npx -y groundwork-mcp   (Claude Code)`);
  console.log(`  codex mcp add groundwork -- npx -y groundwork-mcp    (Codex)`);
  return 0;
}

function cmdValidate(json: boolean, against?: string) {
  const root = findRoot();
  const problems = [...validate(load(root), readConfig(root)), ...(against ? clashProblems(root, against) : [])];
  const errors = problems.filter((p) => p.level === "error");
  if (json) {
    console.log(JSON.stringify({ ok: !errors.length, problems }, null, 2));
  } else {
    for (const p of problems) console.log(`${p.level === "error" ? red("error") : yellow("warning")} ${p.file}: ${p.message}`);
    const counts = `${errors.length} error${errors.length === 1 ? "" : "s"}, ${problems.length - errors.length} warning${problems.length - errors.length === 1 ? "" : "s"}`;
    console.log(errors.length ? red(counts) : green(problems.length ? counts : "All items and links are valid."));
  }
  return errors.length ? 1 : 0;
}

function cmdRenumber(against?: string) {
  if (!against) {
    console.error("Usage: groundwork renumber --against <base branch>, e.g. --against origin/main");
    return 1;
  }
  const { renumbered, rewritten, mentions } = renumber(findRoot(), against);
  if (!renumbered.length) {
    console.log(green(`Nothing to renumber: no ids clash with ${against}.`));
    return 0;
  }
  for (const r of renumbered) console.log(`${bold(r.from)} → ${bold(r.to)}  ${r.newPath}`);
  if (rewritten.length) console.log(dim(`Updated links in: ${rewritten.join(", ")}`));
  for (const m of mentions) console.log(`${yellow("warning")} ${m.file}: mentions ${m.id} in its notes; update that by hand`);
  return 0;
}

function cmdTrace(id: string) {
  const loaded = load(findRoot());
  const byId = index(loaded);
  const root = byId.get(id);
  if (!root) {
    console.error(red(`No item with id ${id}.`));
    return 1;
  }
  console.log(label(root.kind, root.item));
  const seen = new Set([id]);
  const walk = (cur: string, prefix: string) => {
    const hit = byId.get(cur)!;
    const next = outgoing(hit.kind, hit.item as never).filter((x) => byId.has(x));
    next.forEach((x, i) => {
      const last = i === next.length - 1;
      const child = byId.get(x)!;
      const again = seen.has(x);
      console.log(`${prefix}${last ? "└─ " : "├─ "}${dim(child.kind)} ${label(child.kind, child.item)}${again ? dim(" (shown above)") : ""}`);
      if (!again) {
        seen.add(x);
        walk(x, prefix + (last ? "   " : "│  "));
      }
    });
  };
  walk(id, "");
  const dangling = outgoing(root.kind, root.item as never).filter((x) => !byId.has(x));
  if (dangling.length) console.log(red(`Links to missing items: ${dangling.join(", ")}`));
  return 0;
}

function cmdList(kind?: string) {
  if (kind && !KIND.options.includes(kind as Kind)) {
    console.error(red(`Unknown kind "${kind}". Use one of: ${KIND.options.join(", ")}.`));
    return 1;
  }
  const loaded = load(findRoot());
  for (const k of kind ? [kind as Kind] : KIND.options) {
    const items = loaded.items[COLLECTIONS[k]] as Item[];
    if (!items.length) continue;
    console.log(bold(`${COLLECTIONS[k]} (${items.length})`));
    for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) console.log(`  ${label(k, item)}`);
  }
  return 0;
}

async function cmdImport(to: string | undefined, token: string | undefined, dryRun: boolean, overwrite: boolean) {
  if (!to || !token) {
    console.error("Usage: GROUNDWORK_TOKEN=gw_… groundwork import --to https://<your Groundwork web app> [--dry-run] [--overwrite]");
    console.error("Create the token in the web app: Settings → Connect an agent.");
    return 1;
  }
  const root = findRoot();
  const already = readConfig(root).migrated;
  if (already && !dryRun) console.log(dim(`This folder was imported before (${already}). Items already there are ${overwrite ? "replaced" : "skipped"}.`));
  if (load(root).products.some((p) => p.versions.length)) console.log(yellow("Product versions aren't imported yet."));
  try {
    const r = await runImport({ root, to, token, dryRun, overwrite });
    console.log(`${dryRun ? bold("Dry run, nothing saved. ") : ""}${r.workspace}: ${r.created} new, ${r.updated} replaced, ${r.skipped} already there.`);
    if (r.addedAreas.length) console.log(`Product areas added: ${r.addedAreas.join(", ")}`);
    if (r.addedProducts.length) console.log(`Products added: ${r.addedProducts.join(", ")}`);
    for (const w of r.warnings) console.log(`${yellow("warning")} ${w}`);
    if (!dryRun) {
      console.log(green(`Imported. Open ${r.url}`));
      console.log(`\n${DIR}/config.yml now says migrated, so local tools only read these files. Point your agent at the web app:`);
      const mcpUrl = `${new URL(r.url).origin}/api/mcp`;
      console.log(`\nClaude Code:`);
      console.log(`  claude mcp remove groundwork`);
      console.log(`  claude mcp add --transport http groundwork ${mcpUrl} --header "Authorization: Bearer $GROUNDWORK_TOKEN"`);
      console.log(`\nCodex: run \`codex mcp remove groundwork\`, then add to ~/.codex/config.toml:`);
      console.log(`  [mcp_servers.groundwork]`);
      console.log(`  url = "${mcpUrl}"`);
      console.log(`  bearer_token_env_var = "GROUNDWORK_TOKEN"`);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof ImportError)) throw e;
    console.error(red(e.message));
    for (const p of e.problems.slice(0, 20)) console.error(`  ${p.file}: ${p.message}`);
    return 1;
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      json: { type: "boolean" },
      to: { type: "string" },
      against: { type: "string" },
      token: { type: "string" },
      "dry-run": { type: "boolean" },
      overwrite: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
  });
  const [cmd, arg] = positionals;
  if (values.version) return console.log(VERSION), 0;
  if (values.help || !cmd || cmd === "help") return console.log(HELP), 0;
  switch (cmd) {
    case "init":
      return cmdInit(values.name);
    case "validate":
      return cmdValidate(Boolean(values.json), values.against);
    case "renumber":
      return cmdRenumber(values.against);
    case "trace":
      if (!arg) return console.error("Usage: groundwork trace <ID>"), 1;
      return cmdTrace(arg.toUpperCase());
    case "list":
      return cmdList(arg);
    case "import":
      return cmdImport(values.to, values.token ?? process.env.GROUNDWORK_TOKEN, Boolean(values["dry-run"]), Boolean(values.overwrite));
    case "mcp":
      await runMcp();
      return -1; // keep running
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      return 1;
  }
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((e) => {
    console.error(red(e instanceof ConfigError || e instanceof GitError ? e.message : `groundwork: ${(e as Error).message}`));
    process.exit(1);
  });
