import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer, INSTRUCTIONS } from "../src/mcp/server";

const SKILLS = resolve(__dirname, "../skills");
const CLOUD = resolve(__dirname, "../plugins/groundwork-cloud/skills");
const WEB_APP = resolve(__dirname, "../../centropic-prototype/integrations/claude-code");
/** Snake-case words in the docs that aren't tools: config keys, environment variables, statuses. */
const NOT_TOOLS = new Set(["in_progress"]);

/** Fields the docs name that aren't tool inputs: results, stored fields set by the tools, and config keys. */
const NOT_INPUTS = new Set([
  "ready", "notReady", "noTickets", "warnings", "fulfilledBy", "filesChanged", "signOff", "mitigated", "mitigatedBy",
  "releasedIn", "releasedAt", "releasedBy", "obsoletedIn", "obsoletedBy", "obsoletePlannedFor", "recordedBy", "approvedAt",
  "riskIds", "riskMatrix", "linkedAt", "codeTests", "testCases", "defaultBranch", "resultsBranch", "aiGenerated", "createdAt",
  "knowWhen", "productAreas", "catalogue", "schemaVersion", "migrated",
]);

/** Every property name in the tools' input schemas, however deep. */
function inputFields(schemas: unknown[]): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.properties && typeof o.properties === "object") for (const k of Object.keys(o.properties)) out.add(k);
    Object.values(o).forEach(walk);
  };
  walk(schemas);
  return out;
}

async function listTools() {
  const root = mkdtempSync(join(tmpdir(), "gw-skills-"));
  try {
    const server = buildServer({ root });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(a);
    return (await client.listTools()).tools;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const skillFiles = () => readdirSync(SKILLS).map((d) => ({ name: d, text: readFileSync(join(SKILLS, d, "SKILL.md"), "utf8") }));

describe("skills", () => {
  it("every tool a local skill names exists", async () => {
    const tools = new Set((await listTools()).map((t) => t.name));
    const unknown: string[] = [];
    for (const { name, text } of skillFiles()) {
      // Backticked or not: an agent reads a tool name in prose as one too.
      for (const m of text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) if (!tools.has(m[0]) && !NOT_TOOLS.has(m[0])) unknown.push(`${name}: ${m[0]}`);
    }
    for (const m of INSTRUCTIONS.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) if (!tools.has(m[0]) && !NOT_TOOLS.has(m[0])) unknown.push(`INSTRUCTIONS: ${m[0]}`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("every field a local skill names is a tool input, or a known result or stored field", async () => {
    const fields = inputFields((await listTools()).map((t) => t.inputSchema));
    const unknown: string[] = [];
    for (const { name, text } of skillFiles()) {
      for (const m of text.matchAll(/`([a-z]+[A-Z][A-Za-z]*)`/g)) if (!fields.has(m[1]) && !NOT_INPUTS.has(m[1])) unknown.push(`${name}: ${m[1]}`);
    }
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("every local skill has a name and description in its frontmatter", () => {
    for (const { name, text } of skillFiles()) {
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
      expect(fm, name).toMatch(new RegExp(`^name: ${name}$`, "m"));
      expect(fm, name).toMatch(/^description: .{40,}$/m);
    }
  });

  it.skipIf(!existsSync(WEB_APP))("the cloud plugin's skills match the web app's generated files (runs only with ../centropic-prototype checked out)", () => {
    for (const d of readdirSync(WEB_APP)) {
      expect(readFileSync(join(CLOUD, d, "SKILL.md"), "utf8"), d).toBe(readFileSync(join(WEB_APP, d, "SKILL.md"), "utf8"));
    }
  });
});
