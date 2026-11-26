import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultMatrix, isMitigated, riskLevel } from "../src/core/risk";
import type { Requirement, Risk } from "../src/core/types";
import { ConfigError, matrixOf, readConfig } from "../src/store/config";

const parity = JSON.parse(readFileSync(join(__dirname, "fixtures/parity/risk-levels.json"), "utf8")) as {
  levels: { size: 3 | 5; p: number; s: number; level: string | null }[];
  mitigated: { name: string; size: 3 | 5; risk: Partial<Risk>; requirements: Partial<Requirement>[]; expected: boolean }[];
};

describe("risk scoring", () => {
  it("riskLevel matches the parity fixture", () => {
    for (const c of parity.levels) expect(riskLevel(defaultMatrix(c.size), c.p, c.s), `${c.size} ${c.p}×${c.s}`).toBe(c.level);
  });

  it("isMitigated matches the parity fixture", () => {
    for (const c of parity.mitigated) {
      expect(isMitigated(defaultMatrix(c.size), c.risk as Risk, c.requirements as Requirement[]), c.name).toBe(c.expected);
    }
  });

  it("defaultMatrix(3) has the web app's labels", () => {
    expect(defaultMatrix(3).probabilityLabels).toEqual(["Low", "Medium", "High"]);
  });
});

describe("riskMatrix in config.yml", () => {
  let root: string | undefined;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));
  const withConfig = (yaml: string) => {
    root = mkdtempSync(join(tmpdir(), "groundwork-"));
    mkdirSync(join(root, "groundwork"));
    writeFileSync(join(root, "groundwork", "config.yml"), yaml);
    return root;
  };

  it("matrixOf returns the 5×5 default when config has none", () => {
    expect(matrixOf(readConfig(withConfig("name: Acme\n")))).toEqual(defaultMatrix(5));
  });

  it("readConfig reads a valid 3×3 riskMatrix", () => {
    const cfg = readConfig(
      withConfig(`name: Acme
riskMatrix:
  size: 3
  probabilityLabels: [Low, Medium, High]
  severityLabels: [Low, Medium, High]
  cells: [[low, low, medium], [low, medium, high], [medium, high, high]]
`),
    );
    expect(matrixOf(cfg).size).toBe(3);
    expect(riskLevel(matrixOf(cfg), 2, 3)).toBe("high");
  });

  it("readConfig rejects a malformed riskMatrix", () => {
    const r = withConfig(`name: Acme
riskMatrix:
  size: 3
  probabilityLabels: [Low, Medium, High]
  severityLabels: [Low, Medium, High]
  cells: [[low, low, medium], [low, medium, high]]
`);
    expect(() => readConfig(r)).toThrow(ConfigError);
    expect(() => readConfig(r)).toThrow(/riskMatrix/);
  });
});
