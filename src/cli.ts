#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { itemTags } from "./core/labels";
import type { RiskMatrix } from "./core/types";
import { KIND, type Kind } from "./core/schemas";
import type { Requirement } from "./core/types";
import { kindOf } from "./core/requirements";
import { ConfigError, DIR, findRoot, isInitialized, matrixOf, readConfig, writeConfig } from "./store/config";
import { COLLECTIONS, load, slug, type Loaded } from "./store/files";
import { validate } from "./store/validate";
import { clashProblems, GitError, renumber } from "./store/branches";
import { migrate, planMigration, type MigrationPlan } from "./store/migrate";
import { outgoing } from "./mcp/server";
import { runMcp } from "./mcp/run";
import { runCheckCommand, runReleaseCommand, runReportCommand } from "./release-cli";
import { runResultsCommand } from "./store/results-cli";
import { prInputFromGit, runCiPrCommand } from "./ci-cli";
import { ImportError, runImport } from "./store/import";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

const HELP = `groundwork ${VERSION}: traceability for software built with agents, in your repo

Usage:
  groundwork init [--name <product>]   Create groundwork/config.yml in this folder
  groundwork validate [--json] [--against <base>]
                                       Check every item and link; with --against, also ids that
                                       clash with <base>. Exits 1 on errors (use it in CI)
  groundwork renumber --against <base>
                                       Give this branch's items that clash with <base> new ids,
                                       and fix links
  groundwork migrate [--dry-run]       Move products and areas from config.yml into product files
                                       (groundwork/products/), so products can have versions
  groundwork release [product] <version> --shipped ID,ID [--removed ID,ID] [--move-rest <version>]
                                       Release a version: what shipped, and where the rest moves.
                                       It's signed off too; with blockers, an owner adds
                                       --justification "…"
  groundwork release [product] <version> --sign-off [--justification "…"]
                                       Sign off a version released before sign-off records
  groundwork release [product] <version> --withdraw --reason "…"
                                       Withdraw a version's sign-off (owners), to correct it
  groundwork release [product] <version> --correct --reason "…" [--add ID] [--remove ID]
                    [--add-obsolete ID] [--remove-obsolete ID] [--move-rest <version>]
                                       Correct a released version (recorded with the reason)
  groundwork report release [product] <version> [--format md|csv] [--table traceability|risks] [--json]
                                       Print a version's traceability report: from its sign-off
                                       record when it has one, as Markdown or CSV
  groundwork results add <junit file or glob>… [--push] [--commit <sha>] [--ref <ref>]
                                       Record a CI run's results for the tests requirements link
                                       to; --push commits them to the results branch (in CI)
  groundwork check release [product] <version> [--json]
                                       What blocks a version from going out. Exits 1 if anything
                                       does (use it in CI before releasing)
  groundwork ci pr --input <pr.json> [--junit <file>]… [--link-base <url>] [--path-prefix <dir/>]
                                       The pull request report as JSON, for the GitHub Action
  groundwork ci pr --against <target branch> [--body <text>] [--junit <file>]… [--markdown]
                   [--fail-on-gaps]    The same, from git: for GitLab, Bitbucket and other CI
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

function label(kind: Kind, item: Item, matrix: RiskMatrix) {
  const tags = itemTags(kind, item, matrix);
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
  const problems = [...validate(load(root), readConfig(root), { root }), ...(against ? clashProblems(root, against) : [])];
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
  const { renumbered, rewritten, mentions, tickets, tests } = renumber(findRoot(), against);
  if (!renumbered.length) {
    console.log(green(`Nothing to renumber: no ids clash with ${against}.`));
    return 0;
  }
  for (const r of renumbered) console.log(`${bold(r.from)} → ${bold(r.to)}  ${r.newPath}`);
  if (rewritten.length) console.log(dim(`Updated links in: ${rewritten.join(", ")}`));
  for (const m of mentions) console.log(`${yellow("warning")} ${m.file}: mentions ${m.id} in its notes; update that by hand`);
  for (const t of tickets) console.log(`${yellow("warning")} ${t.from} → ${t.to} has tickets ${t.tickets.join(", ")}: update the REQ id there`);
  for (const t of tests) {
    console.log(`${yellow("warning")} ${t.from} → ${t.to} has tests named after ${t.from}: ${t.tests.join(", ")}. Rename them, then unlink the old name and link the new one`);
  }
  return 0;
}

function cmdMigrate(dryRun: boolean) {
  const root = findRoot();
  const plan: MigrationPlan | undefined = dryRun ? planMigration(root) : migrate(root);
  if (!plan) {
    console.log(green("Nothing to migrate."));
    return 0;
  }
  if (dryRun) console.log(bold("Dry run, nothing changed."));
  for (const p of plan.products) {
    console.log(`${bold(p.id)} ${p.title}  ${dim(`groundwork/products/${p.id}-${slug(p.title)}.md`)}${p.areas.length ? `, areas: ${p.areas.map((a) => a.label).join(", ")}` : ""}`);
  }
  for (const r of plan.requirementProducts) console.log(dim(`${r.file}: product "${r.from}" → ${r.to}`));
  for (const u of plan.unknownProducts) console.log(`${yellow("warning")} ${u.file}: product "${u.value}" isn't a known product; left as it is`);
  for (const n of plan.notes) console.log(yellow(n));
  if (!dryRun) console.log(green("Migrated. Older groundwork-mcp versions won't read this folder: update them with npx -y groundwork-mcp@latest."));
  return 0;
}

function cmdTrace(id: string) {
  const loaded = load(findRoot());
  const matrix = matrixOf(readConfig(findRoot()));
  const byId = index(loaded);
  const root = byId.get(id);
  if (!root) {
    console.error(red(`No item with id ${id}.`));
    return 1;
  }
  console.log(label(root.kind, root.item, matrix));
  const seen = new Set([id]);
  const walk = (cur: string, prefix: string) => {
    const hit = byId.get(cur)!;
    const next = outgoing(hit.kind, hit.item as never).filter((x) => byId.has(x));
    next.forEach((x, i) => {
      const last = i === next.length - 1;
      const child = byId.get(x)!;
      const again = seen.has(x);
      console.log(`${prefix}${last ? "└─ " : "├─ "}${dim(child.kind)} ${label(child.kind, child.item, matrix)}${again ? dim(" (shown above)") : ""}`);
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
  const matrix = matrixOf(readConfig(findRoot()));
  for (const k of kind ? [kind as Kind] : KIND.options) {
    const items = loaded.items[COLLECTIONS[k]] as Item[];
    if (!items.length) continue;
    console.log(bold(`${COLLECTIONS[k]} (${items.length})`));
    for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) console.log(`  ${label(k, item, matrix)}`);
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
      shipped: { type: "string" },
      removed: { type: "string" },
      "move-rest": { type: "string" },
      correct: { type: "boolean" },
      reason: { type: "string" },
      add: { type: "string" },
      remove: { type: "string" },
      "add-obsolete": { type: "string" },
      "remove-obsolete": { type: "string" },
      token: { type: "string" },
      "dry-run": { type: "boolean" },
      overwrite: { type: "boolean" },
      commit: { type: "string" },
      format: { type: "string" },
      justification: { type: "string" },
      input: { type: "string" },
      body: { type: "string" },
      markdown: { type: "boolean" },
      "fail-on-gaps": { type: "boolean" },
      junit: { type: "string", multiple: true },
      "link-base": { type: "string" },
      "path-prefix": { type: "string" },
      "sign-off": { type: "boolean" },
      withdraw: { type: "boolean" },
      table: { type: "string" },
      ref: { type: "string" },
      push: { type: "boolean" },
      at: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
  });
  const [cmd, arg] = positionals;
  const list = (v: string | undefined) => (v === undefined ? undefined : v.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));
  /** [product] <version>: the version is the last positional; a product before it is optional. */
  const productVersion = (rest: string[]) => (rest.length > 1 ? { product: rest[0], version: rest[1] } : { version: rest[0] });
  const print = (out: { code: number; lines: string[]; report?: true }) => {
    const failed = out.code && !out.report;
    for (const l of out.lines) (failed ? console.error : console.log)(failed ? red(l) : l);
    return out.code;
  };
  if (values.version) return console.log(VERSION), 0;
  if (values.help || !cmd || cmd === "help") return console.log(HELP), 0;
  switch (cmd) {
    case "init":
      return cmdInit(values.name);
    case "validate":
      return cmdValidate(Boolean(values.json), values.against);
    case "release": {
      const pv = productVersion(positionals.slice(1));
      if (!pv.version) return console.error("Usage: groundwork release [product] <version> --shipped ID,ID [--move-rest <version>]"), 1;
      return print(
        runReleaseCommand(findRoot(), {
          ...pv,
          shipped: list(values.shipped),
          removed: list(values.removed),
          moveRest: values["move-rest"],
          correct: Boolean(values.correct),
          reason: values.reason,
          add: list(values.add),
          remove: list(values.remove),
          addObsolete: list(values["add-obsolete"]),
          removeObsolete: list(values["remove-obsolete"]),
          justification: values.justification,
          signOff: Boolean(values["sign-off"]),
          withdraw: Boolean(values.withdraw),
        }),
      );
    }
    case "report": {
      const pv = productVersion(positionals.slice(2));
      if (arg !== "release" || !pv.version) return console.error("Usage: groundwork report release [product] <version> [--format md|csv] [--table traceability|risks] [--json]"), 1;
      return print(runReportCommand(findRoot(), { ...pv, json: Boolean(values.json), format: values.format, table: values.table }));
    }
    case "migrate":
      return cmdMigrate(Boolean(values["dry-run"]));
    case "renumber":
      return cmdRenumber(values.against);
    case "ci": {
      const usage = "Usage: groundwork ci pr (--input <pr.json> | --against <target branch> [--body <text>]) [--junit <file>]… [--link-base <url>] [--path-prefix <dir/>] [--markdown] [--fail-on-gaps]";
      if (arg !== "pr" || !values.input === !values.against) return console.error(usage), 1;
      const root = findRoot();
      let input: unknown;
      let pathPrefix = values["path-prefix"];
      if (values.input) {
        try {
          input = JSON.parse(readFileSync(values.input, "utf8"));
        } catch (e) {
          return console.error(`Can't read ${values.input}: ${(e as Error).message}`), 1;
        }
      } else {
        try {
          const fromGit = prInputFromGit(root, values.against!, values.body ?? "");
          input = fromGit.input;
          pathPrefix ??= fromGit.pathPrefix;
        } catch (e) {
          return console.error((e as Error).message), 1;
        }
      }
      return print(
        runCiPrCommand(root, { input: input as never, junit: values.junit, linkBase: values["link-base"], pathPrefix, format: values.markdown ? "markdown" : "json", failOnGaps: Boolean(values["fail-on-gaps"]) }),
      );
    }
    case "check": {
      const pv = productVersion(positionals.slice(2));
      if (arg !== "release" || !pv.version) return console.error("Usage: groundwork check release [product] <version> [--json]"), 1;
      return print(runCheckCommand(findRoot(), { ...pv, json: Boolean(values.json) }));
    }
    case "results": {
      const files = positionals.slice(2);
      if (arg !== "add" || !files.length) return console.error("Usage: groundwork results add <junit file or glob>… [--push] [--commit <sha>] [--ref <ref>]"), 1;
      return print(await runResultsCommand(findRoot(), process.cwd(), { files, commit: values.commit, ref: values.ref, push: Boolean(values.push), at: values.at }));
    }
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
