import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The groundwork-cloud plugin's hook scripts, run the way Claude Code runs them: hook input as JSON on stdin. */
const PLUGIN = resolve(__dirname, "../plugins/groundwork-cloud");
const run = (script: string, input: object, token?: string) => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  if (token) env.GROUNDWORK_TOKEN = token;
  const r = spawnSync("sh", [resolve(PLUGIN, "hooks", script)], { input: JSON.stringify(input), env, encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout;
};
const bash = (command: string) => ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } });

describe("groundwork-cloud plugin hooks", () => {
  it("say nothing in a repository without a Groundwork token", () => {
    expect(run("session-start.sh", { hook_event_name: "SessionStart" })).toBe("");
    expect(run("after-pr.sh", bash("gh pr create --fill"))).toBe("");
  });

  it("remind Claude of the workflow when a session starts", () => {
    expect(run("session-start.sh", { hook_event_name: "SessionStart" }, "gw_x")).toContain("groundwork skill");
  });

  it("add the PR steps as context after gh pr create, and only then", () => {
    const out = JSON.parse(run("after-pr.sh", bash("gh pr create --title x --body y"), "gw_x"));
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PostToolUse" });
    expect(out.hookSpecificOutput.additionalContext).toContain("Groundwork: REQ-0042");
    expect(run("after-pr.sh", bash("git status"), "gw_x")).toBe("");
  });

  it("ships valid plugin, MCP and hook configuration, and is listed in the marketplace", () => {
    for (const f of [".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json"]) expect(() => JSON.parse(readFileSync(resolve(PLUGIN, f), "utf8"))).not.toThrow();
    const market = JSON.parse(readFileSync(resolve(__dirname, "../.claude-plugin/marketplace.json"), "utf8"));
    expect(market.plugins.map((p: { name: string; source: string }) => [p.name, p.source])).toContainEqual(["groundwork-cloud", "./plugins/groundwork-cloud"]);
    // The token comes from the environment; it's never in the repository.
    expect(readFileSync(resolve(PLUGIN, ".mcp.json"), "utf8")).toContain("${GROUNDWORK_TOKEN}");
  });
});
