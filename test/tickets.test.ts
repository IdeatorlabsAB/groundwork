import { describe, expect, it } from "vitest";
import * as ops from "../src/core/ops";
import { ticketsOf } from "../src/core/requirements";
import type { Requirement } from "../src/core/types";
import { ctx, ID, USER, workspace } from "./fixtures";

const apply = <R>(s: ReturnType<typeof workspace>, c: ops.Change<R>) => ({ ...s, ...c.next });
const tickets = (s: ReturnType<typeof workspace>, id: string) => s.requirements.find((r) => r.id === id)!.tickets ?? [];

describe("tickets on requirements", () => {
  it("links one ticket to several requirements, once each", () => {
    let s = workspace();
    s = apply(s, ops.linkTickets(s, ctx(), [ID.solutionReq, ID.approvedReq], { tracker: "Linear", key: "cln-142", url: "https://linear.app/x/CLN-142" }));
    s = apply(s, ops.linkTickets(s, ctx(), [ID.solutionReq], { tracker: "linear", key: "CLN-142" }));
    expect(tickets(s, ID.solutionReq)).toEqual([expect.objectContaining({ tracker: "linear", key: "cln-142", linkedBy: USER })]);
    expect(tickets(s, ID.approvedReq)).toHaveLength(1);
  });

  it("updates ticket states everywhere, and reports tickets that aren't linked", () => {
    let s = workspace();
    s = apply(s, ops.linkTickets(s, ctx(), [ID.solutionReq, ID.approvedReq], { tracker: "linear", key: "CLN-142" }));
    const change = ops.updateTickets(s, ctx(), [
      { tracker: "linear", key: "cln-142", state: "Done", done: true },
      { tracker: "jira", key: "OPS-1", done: true },
    ]);
    expect(change.result).toEqual({ updated: 2, notLinked: [{ tracker: "jira", key: "OPS-1" }] });
    s = apply(s, change);
    expect(tickets(s, ID.approvedReq)[0]).toMatchObject({ state: "Done", done: true });
  });

  it("unlinks a ticket", () => {
    let s = workspace();
    s = apply(s, ops.linkTickets(s, ctx(), [ID.solutionReq], { tracker: "linear", key: "CLN-142" }));
    s = apply(s, ops.unlinkTickets(s, ctx(), [ID.solutionReq], { tracker: "LINEAR", key: "cln-142" }));
    expect(tickets(s, ID.solutionReq)).toEqual([]);
  });

  it("shows the web app's single Linear issue as a ticket", () => {
    const r = {
      delivery: {
        tracker: "linear",
        issueId: "x",
        identifier: "MER-1",
        url: "https://linear.app/m/MER-1",
        state: { name: "Done", type: "completed" },
        sentAt: "2026-11-01T00:00:00.000Z",
        syncedAt: "2026-11-02T00:00:00.000Z",
      },
    } as unknown as Requirement;
    expect(ticketsOf(r)).toEqual([expect.objectContaining({ tracker: "linear", key: "MER-1", state: "Done", done: true, linkedAt: "2026-11-01T00:00:00.000Z" })]);
  });
});

describe("the web app's Linear issue as a ticket", () => {
  const withDelivery = () => {
    const s = workspace();
    s.requirements = s.requirements.map((r) =>
      r.id === ID.approvedReq
        ? ({ ...r, delivery: { tracker: "linear", issueId: "x", identifier: "MER-1", state: { name: "In Progress", type: "started" }, sentAt: "2026-11-01T00:00:00.000Z", syncedAt: "2026-11-01T00:00:00.000Z" } } as typeof r)
        : r,
    );
    return s;
  };

  it("can be refreshed with update_tickets", () => {
    const s = withDelivery();
    const change = ops.updateTickets(s, ctx(), [{ tracker: "linear", key: "MER-1", state: "Done", done: true }]);
    expect(change.result).toEqual({ updated: 1, notLinked: [] });
    expect(ticketsOf(apply(s, change).requirements.find((r) => r.id === ID.approvedReq)!)[0]).toMatchObject({ key: "MER-1", done: true });
  });

  it("keeps its original link time when linked again", () => {
    const s = withDelivery();
    const after = apply(s, ops.linkTickets(s, ctx(), [ID.approvedReq], { tracker: "linear", key: "MER-1", title: "Import" }));
    expect(after.requirements.find((r) => r.id === ID.approvedReq)!.tickets).toEqual([expect.objectContaining({ key: "MER-1", linkedAt: "2026-11-01T00:00:00.000Z", title: "Import" })]);
  });
});
