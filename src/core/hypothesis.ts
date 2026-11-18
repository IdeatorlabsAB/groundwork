import type { SuccessMetric } from "./types";

export function hasSuccessMetric(m?: SuccessMetric): m is SuccessMetric {
  return Boolean(m && m.name.trim());
}

function lowerFirst(s: string) {
  // Keep acronyms ("NPS score") intact.
  return s.length > 1 && s[1] === s[1].toUpperCase() && /[A-Z]/.test(s[1]) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

/** "week-1 activation rises from 38 to 55% or more over a 4-week prototype test" */
export function describeSuccess(m: SuccessMetric): string {
  const verb = m.direction === "decrease" ? "falls" : "rises";
  const bound = m.direction === "decrease" ? "or less" : "or more";
  const unit = m.unit ? ` ${m.unit}` : "";
  const when = m.timeframe.trim() ? ` ${m.timeframe.trim()}` : "";
  return `${lowerFirst(m.name.trim())} ${verb} from ${m.baseline} to ${m.target}${unit} ${bound}${when}`;
}

/** The plain-language success statement, from the success metric and the guardrail. Empty without a metric. */
export function composeKnowWhen(d: { successMetric?: SuccessMetric; guardrail?: string }): string {
  if (!hasSuccessMetric(d.successMetric)) return "";
  const g = (d.guardrail ?? "").trim();
  return describeSuccess(d.successMetric) + (g ? `, without ${g}` : "");
}

/** "We believe we will [outcome] if [forWhom] get [benefit] with [feature]." */
export function composeStatement(h: { outcome: string; forWhom: string; benefit: string; feature: string }): string {
  return `We believe we will ${h.outcome.trim()} if ${h.forWhom.trim()} get ${h.benefit.trim()} with ${h.feature.trim()}.`;
}
