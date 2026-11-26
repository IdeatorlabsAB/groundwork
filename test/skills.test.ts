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

async function toolNames(): Promise<Set<string>> {
  const root = mkdtempSync(join(tmpdir(), "gw-skills-"));
  try {
    const server = buildServer({ root });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(a);
    return new Set((await client.listTools()).tools.map((t) => t.name));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const skillFiles = () => readdirSync(SKILLS).map((d) => ({ name: d, text: readFileSync(join(SKILLS, d, "SKILL.md"), "utf8") }));
const snake = /^[a-z]+(_[a-z]+)+$/;

describe("skills", () => {
  it("every tool a local skill names exists", async () => {
    const tools = await toolNames();
    const unknown: string[] = [];
    for (const { name, text } of skillFiles()) {
      for (const m of text.matchAll(/`([^`\s]+)`/g)) if (snake.test(m[1]) && !tools.has(m[1]) && !NOT_TOOLS.has(m[1])) unknown.push(`${name}: ${m[1]}`);
    }
    for (const m of INSTRUCTIONS.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) if (!tools.has(m[0]) && !NOT_TOOLS.has(m[0])) unknown.push(`INSTRUCTIONS: ${m[0]}`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("every local skill has a name and description in its frontmatter", () => {
    for (const { name, text } of skillFiles()) {
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
      expect(fm, name).toMatch(new RegExp(`^name: ${name}$`, "m"));
      expect(fm, name).toMatch(/^description: .{40,}$/m);
    }
  });

  it.skipIf(!existsSync(WEB_APP))("the cloud plugin's skills match the web app's generated files", () => {
    for (const d of readdirSync(WEB_APP)) {
      expect(readFileSync(join(CLOUD, d, "SKILL.md"), "utf8"), d).toBe(readFileSync(join(WEB_APP, d, "SKILL.md"), "utf8"));
    }
  });
});
