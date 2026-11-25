---
name: groundwork-risk
description: Use when planning or reviewing a code change for a product whose risks are kept in Groundwork, to decide whether the change introduces or affects a product risk (a hazard that could harm users, patients, customers or the business), and to record it with its probability, severity, mitigating requirements and residual score on the workspace's risk matrix.
---

<!-- Generated from src/lib/ai/skills/risk.ts by `npm run skills:build`. Don't edit by hand. -->

# Analyse risks in Groundwork

A risk is what could go wrong **with the product** for the people who use it or depend on it, not a project risk like a slipping deadline. Regulated teams must show, for every release, that the risks were analysed and every high risk was controlled by an approved requirement before it went out.

## When a change touches risk

Ask of every new need or change in the plan:
- **Wrong result:** could it show, compute, store or send something wrong? A wrong dose, unit, amount, date, person or status.
- **Missing result:** could something not happen that should? An alert, a save, a sync, a payment, a notification.
- **Wrong person:** could someone see or change what they shouldn't, or lose access they need?
- **Unsafe state:** could it fail half-way, run twice, or leave data inconsistent?
- **Misuse:** could a reasonable person misread or misuse it because of how it's presented?

Also call `trace_code` on the files in scope: a file whose codeRefs name a risk, or a requirement that mitigates one, means the change affects that risk.

## Record it

1. `get_workspace` gives the `riskMatrix`: its size (3 or 5) and the label of each probability and severity level. Score on that matrix only.
2. `search_items` with kind `risk` for the same hazard. Update an existing risk rather than adding a near-duplicate.
3. Write the risk:
   - **title**: one line naming what could go wrong;
   - **hazard**: what could go wrong, and why;
   - **harm**: who gets hurt, and how;
   - **probability** and **severity** before any mitigation, as whole numbers from 1 to the matrix size.

   Say briefly why you chose each score. When unsure, choose the higher severity and say so; people review it in the app.
4. **Mitigate.** A high risk needs at least one solution requirement that controls it. Write the requirement with the `groundwork-write-requirement` skill, then `link_items` the risk to it.
5. **Residual score.** Set residualProbability and residualSeverity for what's left once the mitigations are in place. A high risk only counts as controlled when its residual score is no longer high, and its mitigations are approved and, if they're new in the release, tested.
6. **Release.** Tag the risk for the release it's introduced in or affects (`link_items` risk → release), and set codeRefs to the code where the hazard lives or the control is.

## Never

- Lower a score to get a release through. If the honest residual score is still high, leave it and tell the user what would bring it down.
- Accept a residual risk on the team's behalf. People do that in the app.
