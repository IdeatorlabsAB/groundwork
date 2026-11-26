---
id: RSK-0001
title: Imports attributed to the wrong person
hazard: The importer runs under a shared service account, so an import can't be traced to the person who ran it.
harm: Acme can't show auditors who imported which data, and fails its record-keeping obligations.
probability: 3
severity: 4
residualProbability: 1
residualSeverity: 4
mitigationIds:
  - REQ-0003
product: PRD-0001
versions:
  - "1.1"
category: domain
domain: regulatory-compliance
owner: sam
productArea: onboarding
createdAt: 2026-11-26T10:00:00.000Z
---

Raised while planning the audit log for 1.1.
