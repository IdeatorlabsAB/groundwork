import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReleaseCommand, runReportCommand } from "../src/release-cli";
import { readConfig, writeConfig } from "../src/store/config";
import { load, save } from "../src/store/files";
import { writeProduct } from "../src/store/products";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gw-release-cli-"));
  cpSync(join(__dirname, "../examples/acme/groundwork"), join(root, "groundwork"), { recursive: true });
  // Start from acme before its 1.0 release.
  const loaded = load(root);
  const p = loaded.products[0];
  if (p.versions[0].status === "released") {
    const { status: _s, releasedAt: _a, releasedBy: _b, corrections: _c, ...v } = p.versions[0];
    void _s, void _a, void _b, void _c;
    writeProduct(root, { ...p, versions: [{ ...v, status: "planned" }, ...p.versions.slice(1)] }, loaded.paths.get(p.id));
    save(root, loaded, {
      ...loaded.items,
      requirements: loaded.items.requirements.map(({ releasedIn: _i, releasedAt: _x, releasedBy: _y, ...r }) => (void _i, void _x, void _y, r)),
    });
  }
  process.env.GROUNDWORK_USER = "sam";
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.GROUNDWORK_USER;
});

describe("groundwork release and report", () => {
  it("releases a version and prints its report", () => {
    const out = runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"] });
    expect(out.code).toBe(0);
    const report = runReportCommand(root, { version: "1.0" });
    expect(report.code).toBe(0);
    expect(report.lines.join("\n")).toContain("# Acme app 1.0: release report");
    expect(report.lines.join("\n")).toContain("REQ-0002");
  });

  it("refuses releasing twice and points at --correct", () => {
    runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"] });
    const again = runReleaseCommand(root, { version: "1.0", shipped: [] });
    expect(again.code).toBe(1);
    expect(again.lines.join("\n")).toContain("--correct");
  });

  it("refuses a viewer", () => {
    const config = readConfig(root);
    writeConfig(root, { ...config, people: [...config.people, { id: "vic", name: "Vic", role: "viewer" }] });
    process.env.GROUNDWORK_USER = "vic";
    const out = runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"] });
    expect(out).toEqual({ code: 1, lines: ["Viewers can't release."] });
  });

  it("corrects a release with a reason", () => {
    runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"] });
    expect(runReleaseCommand(root, { version: "1.0", correct: true, remove: ["REQ-0002"], moveRest: "1.1" }).code).toBe(1);
    const out = runReleaseCommand(root, { version: "1.0", correct: true, reason: "Import wizard was behind a flag", remove: ["REQ-0002"], moveRest: "1.1" });
    expect(out.code).toBe(0);
    expect(runReportCommand(root, { version: "1.0" }).lines.join("\n")).toContain("Import wizard was behind a flag");
  });
});

describe("groundwork release refuses ambiguous commands", () => {
  it("refuses correction flags without --correct, and a release without --shipped", () => {
    expect(runReleaseCommand(root, { version: "1.0", reason: "oops", remove: ["REQ-0002"] }).code).toBe(1);
    expect(runReleaseCommand(root, { version: "1.0" }).lines.join(" ")).toMatch(/--shipped/);
    expect(runReleaseCommand(root, { version: "1.0", correct: true, reason: "x", shipped: ["REQ-0002"] }).code).toBe(1);
    expect(load(root).products[0].versions[0].status).toBe("planned");
  });
});
