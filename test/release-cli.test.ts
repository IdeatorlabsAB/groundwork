import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheckCommand, runReleaseCommand, runReportCommand } from "../src/release-cli";
import { readConfig, writeConfig } from "../src/store/config";
import { load, save } from "../src/store/files";
import { writeProduct } from "../src/store/products";
import { withdrawRecord } from "../src/store/signoff";

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
    const out = runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"], justification: "Release mechanics test: no tests linked." });
    expect(out.code).toBe(0);
    const report = runReportCommand(root, { version: "1.0" });
    expect(report.code).toBe(0);
    expect(report.lines.join("\n")).toContain("# Acme app 1.0: release report");
    expect(report.lines.join("\n")).toContain("REQ-0002");
  });

  it("refuses releasing twice and points at --correct", () => {
    runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"], justification: "Release mechanics test: no tests linked." });
    const again = runReleaseCommand(root, { version: "1.0", shipped: [] });
    expect(again.code).toBe(1);
    expect(again.lines.join("\n")).toContain("--correct");
  });

  it("refuses a viewer", () => {
    const config = readConfig(root);
    writeConfig(root, { ...config, people: [...config.people, { id: "vic", name: "Vic", role: "viewer" }] });
    process.env.GROUNDWORK_USER = "vic";
    const out = runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"], justification: "Release mechanics test: no tests linked." });
    expect(out).toEqual({ code: 1, lines: ["Viewers can't release."] });
  });

  it("corrects a release with a reason", () => {
    runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"], justification: "Release mechanics test: no tests linked." });
    withdrawRecord(root, "groundwork/releases/PRD-0001-1-0-1.json", "sam", "Import wizard was behind a flag", new Date().toISOString());
    expect(runReleaseCommand(root, { version: "1.0", correct: true, remove: ["REQ-0002"], moveRest: "1.1" }).code).toBe(1);
    const out = runReleaseCommand(root, { version: "1.0", correct: true, reason: "Import wizard was behind a flag", remove: ["REQ-0002"], moveRest: "1.1" });
    expect(out.code).toBe(0);
    expect(runReportCommand(root, { version: "1.0" }).lines.join("\n")).toContain("Import wizard was behind a flag");
  });
});

describe("groundwork release through the gate", () => {
  it("refuses a version with blockers without --justification", () => {
    const out = runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"] });
    expect(out.code).toBe(1);
    expect(out.lines[0]).toBe("Acme app 1.0 isn't ready: 1 blocker.");
    expect(out.lines.at(-1)).toBe('An owner can release it anyway: add --justification "…".');
    expect(load(root).products[0].versions[0].status).toBe("planned");
  });

  it("--justification lets an owner release over blockers, and writes the record", () => {
    const out = runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"], justification: "Pilot release." });
    expect(out.code).toBe(0);
    expect(out.lines.at(-1)).toMatch(/Signed off: groundwork\/releases\/PRD-0001-1-0-1\.json/);
    expect(load(root).products[0].versions[0].signOff).toBe("groundwork/releases/PRD-0001-1-0-1.json");
  });

  it("--correct on a signed-off version is refused", () => {
    runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"], justification: "Pilot release." });
    const out = runReleaseCommand(root, { version: "1.0", correct: true, reason: "x", remove: ["REQ-0002"], moveRest: "1.1" });
    expect(out).toEqual({ code: 1, lines: ["Acme app 1.0 is signed off (groundwork/releases/PRD-0001-1-0-1.json). Withdraw the sign-off first (withdraw_release), then sign off again."] });
  });

  it("--sign-off signs off a version released before sign-off records", () => {
    runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"], justification: "Pilot release." });
    // Make it look released before sign-off records.
    const loaded = load(root);
    const p = loaded.products[0];
    rmSync(join(root, "groundwork/releases"), { recursive: true, force: true });
    writeProduct(root, { ...p, versions: p.versions.map(({ signOff: _s, ...v }) => (void _s, v)) }, loaded.paths.get(p.id));
    expect(runReleaseCommand(root, { version: "1.0", signOff: true }).code).toBe(1);
    const out = runReleaseCommand(root, { version: "1.0", signOff: true, justification: "Released before Groundwork checked tests." });
    expect(out.code).toBe(0);
    expect(load(root).products[0].versions[0].signOff).toBe("groundwork/releases/PRD-0001-1-0-1.json");
  });
});

describe("groundwork check release", () => {
  it("groundwork check release exits 1 with blockers and 0 when ready", () => {
    const blocked = runCheckCommand(root, { version: "1.0" });
    expect(blocked.code).toBe(1);
    expect(blocked.lines).toContain('- Requirement "Guided CSV import" has no linked tests');
    runReleaseCommand(root, { version: "1.0", shipped: ["REQ-0002"], justification: "Pilot release." });
    const signed = runCheckCommand(root, { version: "1.0" });
    expect(signed.code).toBe(0);
    expect(signed.lines[0]).toBe("Acme app 1.0 is signed off: groundwork/releases/PRD-0001-1-0-1.json, by Sam.");
  });

  it("--json prints the same as check_release", () => {
    const out = runCheckCommand(root, { version: "1.0", json: true });
    expect(JSON.parse(out.lines.join("\n"))).toMatchObject({ version: "1.0", status: "planned", ready: false });
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
