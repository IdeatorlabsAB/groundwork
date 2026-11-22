import { describe, expect, it } from "vitest";
import { mergeAreas, mergeProducts, mergeVersions, slugify, WorkspaceError } from "../src/core/workspace";

describe("slugify", () => {
  it("turns a label into an id", () => {
    expect(slugify("Onboarding & Setup")).toBe("onboarding-setup");
    expect(slugify("  Billing  ")).toBe("billing");
    expect(slugify("!!!")).toBe("");
    expect(slugify("a".repeat(50))).toHaveLength(40);
  });
});

describe("mergeAreas", () => {
  const onboarding = { id: "onboarding", label: "Onboarding" };

  it("adds new areas with generated ids", () => {
    const r = mergeAreas([], [{ label: "Onboarding" }, { label: "Monthly reports" }]);
    expect(r.added).toEqual([onboarding, { id: "monthly-reports", label: "Monthly reports" }]);
    expect(r.list).toEqual(r.added);
    expect(r.alreadyThere).toEqual([]);
  });

  it("skips an existing area by label", () => {
    const r = mergeAreas([onboarding], [{ label: "onboarding" }]);
    expect(r.added).toEqual([]);
    expect(r.alreadyThere).toEqual([onboarding]);
    expect(r.list).toEqual([onboarding]);
  });

  it("dedupes within one call", () => {
    const r = mergeAreas([], [{ label: "Billing" }, { label: "billing" }]);
    expect(r.added).toHaveLength(1);
    expect(r.alreadyThere).toHaveLength(1);
  });

  it("uses an explicit id", () => {
    expect(mergeAreas([], [{ label: "Sign-up", id: "signup" }]).added[0].id).toBe("signup");
  });

  it("rejects a slug collision", () => {
    expect(() => mergeAreas([{ id: "on-boarding", label: "On boarding" }], [{ label: "On-boarding" }])).toThrow(/already uses/);
    expect(() => mergeAreas([{ id: "on-boarding", label: "On boarding" }], [{ label: "On-boarding" }])).toThrow(WorkspaceError);
  });

  it("rejects a label with no usable slug", () => {
    expect(() => mergeAreas([], [{ label: "!!!" }])).toThrow(/Give an id/);
  });

  it("rejects an invalid explicit id", () => {
    expect(() => mergeAreas([], [{ label: "Onboarding", id: "On Boarding" }])).toThrow(WorkspaceError);
  });

  it("does not mutate existing", () => {
    const existing = [onboarding];
    mergeAreas(existing, [{ label: "Billing" }]);
    expect(existing).toHaveLength(1);
  });
});

describe("mergeProducts", () => {
  it("adds new products and skips ones already there", () => {
    const r = mergeProducts(["Acme app"], ["acme app", "Acme API", "Acme API"]);
    expect(r.added).toEqual(["Acme API"]);
    expect(r.alreadyThere).toEqual(["Acme app", "Acme API"]);
    expect(r.list).toEqual(["Acme app", "Acme API"]);
  });

  it("rejects an empty name", () => {
    expect(() => mergeProducts([], ["  "])).toThrow(WorkspaceError);
  });
});

describe("mergeVersions", () => {
  it("adds new versions as planned, in order, and skips ones already there", () => {
    const r = mergeVersions([{ version: "1.0", status: "released" }], [{ version: "1.0" }, { version: "1.1", plannedFor: "2027-01-15" }, { version: "1.2" }]);
    expect(r.added).toEqual([{ version: "1.1", status: "planned", plannedFor: "2027-01-15" }, { version: "1.2", status: "planned" }]);
    expect(r.alreadyThere).toEqual([{ version: "1.0", status: "released" }]);
    expect(r.list.map((v) => v.version)).toEqual(["1.0", "1.1", "1.2"]);
  });

  it("dedupes within one call", () => {
    expect(mergeVersions([], [{ version: "2.0" }, { version: "2.0" }]).added).toHaveLength(1);
  });
});
