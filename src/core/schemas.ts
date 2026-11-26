import { z } from "zod";

/**
 * Strict input shapes for items written by agents over MCP. Descriptions are shown to the agent, so they explain
 * what each field means in Groundwork's terms.
 *
 * The shapes take the id format as a parameter: the local file store uses readable ids (INS-0001), the hosted app
 * uses UUIDs. Everything else is the same, so agents see the same tools either way.
 */

const short = (max = 200) => z.string().trim().min(1).max(max);
const long = (max = 4000) => z.string().trim().max(max);
const area = z
  .string()
  .max(100)
  .optional()
  .describe("Product area: its label or id from get_workspace. Leave out to inherit it from linked evidence.");

export const SOURCE = z.enum(["interview", "support", "survey", "analytics", "observation"]);
export const SENTIMENT = z.enum(["negative", "neutral", "positive"]);
export const HYPOTHESIS_STATUS = z.enum(["draft", "testing", "validated", "invalidated"]);
export const METHOD = z.enum(["pilot", "ab-test", "prototype-test", "survey", "fake-door", "concierge"]);
export const EXPERIMENT_STATUS = z.enum(["planned", "running", "completed"]);
export const PRIORITY = z.enum(["must", "should", "could"]);
export const REQUIREMENT_KIND = z.enum(["stakeholder", "solution"]);
export const REQUIREMENT_ORIGIN = z.enum(["tender", "regulation", "contract", "customer-need", "existing-product"]);
export const HYPOTHESIS_ORIGIN = z.enum(["inferred"]);
export const FINDING_CONFIDENCE = z.enum(["low", "medium", "high"]);
export const RISK_CATEGORY = z.enum(["security", "domain"]);
export const KIND = z.enum(["insight", "hypothesis", "experiment", "finding", "requirement", "risk"]);
export type Kind = z.infer<typeof KIND>;

/** The input shapes for one id format. `id` validates a single item id. */
export function makeSchemas(id: z.ZodString) {
  const ids = (what: string) => z.array(id).max(100).describe(`Ids of ${what} in this workspace (from search_items or get_item).`);

  const insightInput = z.object({
    title: short().describe("One line naming the pain or need, in plain words."),
    quote: long(2000).min(1).describe("What the person actually said or did, verbatim where possible. This is the evidence."),
    source: SOURCE.describe("Where it came from."),
    persona: short(100).describe('Who said it, as a role or segment, e.g. "Finance manager at a mid-size firm".'),
    participant: z.string().trim().max(100).optional().describe("Optional participant reference, e.g. P07. Never a full name or contact details."),
    tags: z.array(short(40)).max(10).default([]),
    sentiment: SENTIMENT.default("neutral"),
    productArea: area,
  });

  const codeRefs = z
    .array(z.string().trim().min(1).max(300))
    .max(50)
    .optional()
    .describe('Where this shows up in the code: repo-relative paths, optionally with #symbol or :line, e.g. "src/billing/invoice.ts#applyDiscount" or "src/a.ts:12". Never absolute paths.');

  const successMetric = z.object({
    name: short(100),
    unit: z.string().trim().max(20).describe('e.g. "%", "min", "tickets/week"'),
    baseline: z.number(),
    target: z.number(),
    direction: z.enum(["increase", "decrease"]),
    timeframe: z.string().trim().max(100).describe('e.g. "over a 4-week pilot"'),
  });

  const hypothesisInput = z.object({
    title: short(),
    outcome: short(300).describe('"We believe we will [outcome]": the business result the team is after.'),
    forWhom: short(300).describe('"…if [forWhom]": the users.'),
    benefit: short(300).describe('"…[get] [benefit]": what the users gain, in their terms.'),
    feature: short(300).describe('"…with [feature]": the product idea.'),
    successMetric: successMetric.optional().describe("One number with a baseline, target and timeframe. Strongly recommended."),
    guardrail: z.string().trim().max(300).optional().describe("What must not get worse."),
    knowWhen: z
      .string()
      .trim()
      .max(600)
      .optional()
      .describe("Plain-language success statement. Composed from successMetric and guardrail when those are set."),
    alternatives: z.string().trim().max(600).optional().describe("What target users rely on today."),
    edge: z.string().trim().max(600).optional().describe("Why this wins against those alternatives."),
    riskiestAssumption: z.string().trim().max(600).optional(),
    confidence: z.number().int().min(0).max(100).default(50).describe("0-100, how confident the team is before testing."),
    insightIds: ids("the insights this hypothesis is built on").default([]),
    codeRefs,
    origin: HYPOTHESIS_ORIGIN.optional().describe('"inferred" = reverse-engineered from an existing product rather than stated by anyone. Optional.'),
    originNote: z.string().trim().max(300).optional().describe("What it was inferred from."),
    productArea: area,
  });

  const metric = z.object({
    name: short(100),
    unit: z.string().trim().max(20),
    baseline: z.number(),
    target: z.number().describe('Success means actual <= target for "decrease" and actual >= target for "increase".'),
    direction: z.enum(["increase", "decrease"]),
  });

  const experimentInput = z.object({
    hypothesisId: id.describe("The hypothesis this experiment tests."),
    title: short(),
    method: METHOD,
    description: long(4000).min(1).describe("What will be done, with whom, and how results are measured."),
    primaryMetric: metric,
    guardrails: z.array(metric).max(5).default([]),
    sampleSize: z.string().trim().max(100).default("").describe('e.g. "40 accounts"'),
    durationWeeks: z.number().min(0).max(52).default(2),
    checkBackDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("For small bets: YYYY-MM-DD to check whether it made a difference."),
  });

  const findingInput = z.object({
    title: short(),
    summary: long(4000).min(1).describe("What was learned and what it means for the product."),
    experimentIds: ids("the experiments behind it").default([]),
    hypothesisIds: ids("the hypotheses it speaks to").default([]),
    insightIds: ids("supporting insights").default([]),
    confidence: FINDING_CONFIDENCE.default("medium"),
    productArea: area,
  });

  const requirementInput = z.object({
    kind: REQUIREMENT_KIND.describe(
      "stakeholder = who needs what and why, as a user story. solution = the qualities and behaviour the solution must have to meet stakeholder requirements, as \"shall\" statements.",
    ),
    title: short(),
    story: long(2000)
      .min(1)
      .describe(
        'Stakeholder: a user story, "As a <role> I want <need> so that <reason>". Solution: one or more "shall" statements, e.g. "The booking view shall show the calendars of the selected practitioners."',
      ),
    stakeholder: z.string().trim().max(100).optional().describe('Stakeholder requirements: who has the need (the role in the story), e.g. "Medical secretaries".'),
    product: z.string().trim().max(100).optional().describe("Solution requirements: the product that delivers it (one from get_workspace)."),
    stakeholderIds: ids("Solution requirements: required, at least one. The stakeholder requirements this one fulfils").optional(),
    acceptanceCriteria: z.array(short(500)).min(1).max(20),
    priority: PRIORITY.default("should"),
    findingIds: ids("the findings that justify it").default([]),
    insightIds: ids("customer evidence linked directly").optional(),
    hypothesisIds: ids("hypotheses it was committed from").optional(),
    replaces: ids("approved requirements this one replaces; they become obsolete when this one ships").optional(),
    origin: REQUIREMENT_ORIGIN.optional().describe(
      "Where a requirement decided outside the evidence loop comes from (tender, regulation, contract, customer-need, existing-product). Optional.",
    ),
    originNote: z.string().trim().max(300).optional().describe('Where the decision comes from, e.g. "Region North tender 2026, section 4.2".'),
    codeRefs,
    productArea: area,
  });

  /** Checked against the matrix size by the server, so agents get a precise message. */
  const score = (what: string) => z.number().int().describe(`${what}, 1 (lowest) to the matrix size from get_workspace (riskMatrix.size).`);

  // Same fields and descriptions as the web app's riskInput, with versions for its releaseIds. Mitigations are
  // linked with link_items (risk -> requirement), not set here.
  const riskInput = z.object({
    title: short().describe("One line naming what could go wrong."),
    hazard: long(2000).default("").describe("What could go wrong, and why."),
    harm: long(2000).default("").describe("Who gets hurt, and how."),
    probability: score("How likely it is"),
    severity: score("How bad it would be"),
    residualProbability: score("Probability once the mitigations are in place").optional(),
    residualSeverity: score("Severity once the mitigations are in place").optional(),
    product: z.string().trim().max(100).optional().describe("The product this risk belongs to (id or title from get_workspace). Leave out when there's one product."),
    versions: z
      .array(z.string().trim().min(1).max(40))
      .max(50)
      .default([])
      .describe("Planned versions of the same product this risk is introduced in or affects."),
    category: RISK_CATEGORY.optional().describe("security: access, data exposure, injection, auth. domain: harm in the product's own domain (name it in `domain`)."),
    domain: z.string().trim().max(60).optional().describe('For domain risks, which domain, e.g. "patient-safety", "financial", "legal".'),
    codeRefs,
    productArea: area,
  });

  /** Fields an agent may change with update_item, per kind. Status changes with rules have their own tools. */
  const PATCHES = {
    insight: insightInput.partial().extend({ tags: z.array(short(40)).max(10).optional(), sentiment: SENTIMENT.optional() }),
    hypothesis: hypothesisInput.partial().extend({
      status: HYPOTHESIS_STATUS.optional(),
      confidence: z.number().int().min(0).max(100).optional(),
      insightIds: z.array(id).max(100).optional(),
    }),
    experiment: experimentInput
      .omit({ hypothesisId: true })
      .partial()
      .extend({
        guardrails: z.array(metric).max(5).optional(),
        sampleSize: z.string().trim().max(100).optional(),
        durationWeeks: z.number().min(0).max(52).optional(),
        resultNotes: z.string().trim().max(4000).optional(),
      }),
    finding: findingInput.partial().extend({
      experimentIds: z.array(id).max(100).optional(),
      hypothesisIds: z.array(id).max(100).optional(),
      insightIds: z.array(id).max(100).optional(),
      confidence: FINDING_CONFIDENCE.optional(),
    }),
    requirement: requirementInput.partial().extend({
      priority: PRIORITY.optional(),
      findingIds: z.array(id).max(100).optional(),
      kind: REQUIREMENT_KIND.optional(),
    }),
    risk: riskInput.partial().extend({ hazard: long(2000).optional(), harm: long(2000).optional(), versions: z.array(z.string().trim().min(1).max(40)).max(50).optional() }),
  } as const;

  return { id, insightInput, hypothesisInput, experimentInput, findingInput, requirementInput, riskInput, PATCHES };
}

export type Schemas = ReturnType<typeof makeSchemas>;

/** Readable ids used in files: a kind prefix and a number, e.g. INS-0007. */
export const ID_PREFIX = { insight: "INS", hypothesis: "HYP", experiment: "EXP", finding: "FND", requirement: "REQ", risk: "RSK" } as const satisfies Record<
  Kind,
  string
>;
export const LOCAL_ID = /^(INS|HYP|EXP|FND|REQ|RSK)-\d{4,}$/;
export const localId = z.string().regex(LOCAL_ID, "an id like INS-0007");
export const localSchemas = makeSchemas(localId);
