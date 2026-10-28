# Section 09 — Risk register

Status: Proposed mitigation plan; no risk is closed. Parent: [AI outcome quality and maintained integration coverage](09-ai-outcomes-and-qualified-integrations.prd.md).

Likelihood/impact are qualitative judgments, not observed frequencies. High-risk review target **2026-10-31** is a proposed planning checkpoint, not a delivery commitment; staffing and review date need sponsor confirmation. David Tufts is the proposed accountable sponsor; the named functional role below is the proposed mitigation owner, not an assertion of assignment.

| ID | Risk | Likelihood | Impact | Priority | Mitigation | Proposed mitigation owner | Target / gate | State |
|---|---|---|---|---|---|---|---|---|
| S09-K1 | Evaluation leaks sensitive fixtures or overspends vendor keys | M | H | High | Synthetic/consented fixtures, BYOK refs, hard spend caps and explicit execute-time authorization | AI platform / integrations engineering | 2026-10-31 review; before live trials | Open |
| S09-K2 | Judge or happy-path sampling hides unsafe model behavior | M | H | High | Calibrated human holdout, adversarial trials, uncertainty and separate dispositions | AI platform / integrations engineering | 2026-10-31 review; before A-grade AI/integration claim | Open |
