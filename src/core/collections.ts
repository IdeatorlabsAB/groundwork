import type { Activity, Experiment, Finding, Hypothesis, Insight, Requirement } from "./types";

/** A workspace's items, by collection. Shared by the local file store and the hosted app. */
export interface Collections {
  insights: Insight[];
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  findings: Finding[];
  requirements: Requirement[];
  activity: Activity[];
}

export const COLLECTION_KIND = {
  insights: "insight",
  hypotheses: "hypothesis",
  experiments: "experiment",
  findings: "finding",
  requirements: "requirement",
  activity: "activity",
} as const satisfies Record<keyof Collections, string>;

export const COLLECTION_KEYS = Object.keys(COLLECTION_KIND) as (keyof Collections)[];

export const emptyCollections = (): Collections => ({
  insights: [],
  hypotheses: [],
  experiments: [],
  findings: [],
  requirements: [],
  activity: [],
});

export interface Upsert {
  id: string;
  kind: string;
  data: Record<string, unknown>;
}

/**
 * The new, changed and removed items between two snapshots. Items are compared by object identity, which is
 * cheap and right because every change makes a new object.
 */
export function diffCollections(before: Collections, after: Collections): { upserts: Upsert[]; deletes: string[] } {
  const upserts: Upsert[] = [];
  const deletes: string[] = [];
  for (const key of COLLECTION_KEYS) {
    const was = before[key] as { id: string }[];
    const now = after[key] as { id: string }[];
    if (was === now) continue;
    const old = new Map(was.map((x) => [x.id, x]));
    const kept = new Set<string>();
    for (const item of now) {
      kept.add(item.id);
      if (old.get(item.id) !== item) {
        const { id, ...data } = item as { id: string } & Record<string, unknown>;
        upserts.push({ id, kind: COLLECTION_KIND[key], data });
      }
    }
    for (const id of old.keys()) if (!kept.has(id)) deletes.push(id);
  }
  return { upserts, deletes };
}
