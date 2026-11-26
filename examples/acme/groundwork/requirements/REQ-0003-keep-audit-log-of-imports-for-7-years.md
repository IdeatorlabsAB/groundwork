---
id: REQ-0003
title: Keep audit log of imports for 7 years
kind: solution
story: The system shall log every import with who ran it, when, and which file was imported, and shall keep each log entry for 7 years.
product: PRD-0001
stakeholderIds:
  - REQ-0004
riskIds:
  - RSK-0001
codeTests:
  - path: test/import-audit.test.ts
    name: import audit > REQ-0003 records who, when and which file
    linkedAt: 2026-11-27T10:00:00.000Z
    linkedBy: sam
testCases:
  - tool: testrail
    id: C101
    title: Audit log keeps 7 years of imports
    linkedAt: 2026-11-27T10:00:00.000Z
    linkedBy: sam
acceptanceCriteria:
  - Each import records who, when and which file
  - Logs are kept for 7 years
priority: must
origin: regulation
originNote: Record-keeping rules, section 4.2
aiGenerated: true
status: draft
findingIds: []
createdAt: 2026-11-18T08:31:25.148Z
---
