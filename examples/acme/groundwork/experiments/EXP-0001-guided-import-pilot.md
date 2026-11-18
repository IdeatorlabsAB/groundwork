---
id: EXP-0001
title: Guided import pilot
hypothesisId: HYP-0001
method: pilot
description: The next 40 new accounts get the guided import; the rest get today's import. Activation is measured at day 7.
primaryMetric:
  name: Week-1 activation
  unit: "%"
  baseline: 38
  target: 55
  direction: increase
  actual: 61
guardrails:
  - name: Import support tickets
    unit: /week
    baseline: 12
    target: 15
    direction: decrease
    actual: 11
sampleSize: 40 accounts
durationWeeks: 4
status: completed
aiGenerated: true
owner: sam
startDate: 2026-11-18T08:31:25.135Z
endDate: 2026-11-18T08:31:25.137Z
resultNotes: Activation rose to 61%. Tickets about imports dropped slightly.
verdict: validated
---
