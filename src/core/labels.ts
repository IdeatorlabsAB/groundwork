import { kindOf } from "./requirements";
import { initialLevel, residualLevel } from "./risk";
import type { Kind } from "./schemas";
import type { Requirement, Risk, RiskMatrix } from "./types";

/** The short tags the CLI shows after an item's title: its layer and status, a verdict, or a risk's levels. */
export function itemTags(kind: Kind, item: { status?: string; verdict?: string }, matrix: RiskMatrix): string[] {
  if (kind === "risk") {
    const r = item as unknown as Risk;
    const residual = residualLevel(matrix, r);
    return [initialLevel(matrix, r) ?? "unscored", ...(residual ? [`residual ${residual}`] : [])];
  }
  return [kind === "requirement" ? kindOf(item as unknown as Requirement) : undefined, item.status, item.verdict && item.verdict !== item.status ? item.verdict : undefined].filter(
    (x): x is string => !!x,
  );
}
