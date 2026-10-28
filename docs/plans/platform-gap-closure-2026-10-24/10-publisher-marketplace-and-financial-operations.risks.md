# Section 10 — Risk register

Status: Proposed mitigation plan; no risk is closed. Parent: [Publisher lifecycle, marketplace trust and financial operations](10-publisher-marketplace-and-financial-operations.prd.md).

Likelihood/impact are qualitative judgments, not observed frequencies. High-risk review target **2026-10-31** is a proposed planning checkpoint, not a delivery commitment; staffing and review date need sponsor confirmation. David Tufts is the proposed accountable sponsor; the named functional role below is the proposed mitigation owner, not an assertion of assignment.

| ID | Risk | Likelihood | Impact | Priority | Mitigation | Proposed mitigation owner | Target / gate | State |
|---|---|---|---|---|---|---|---|---|
| S10-K1 | Webhook routing/duplicate event strands payment or grants wrong entitlement | M | H | High | Two-secret signed test mode, CAS and cross-lane plan assertions | Marketplace / billing / developer experience | 2026-10-31 review; before commerce release | Open |
| S10-K2 | Pack update/revocation bypasses privilege or historical safety | M | H | High | Signed-tree/permission-diff/revocation tests and runtime trust gate | Marketplace / billing / developer experience | 2026-10-31 review; before marketplace release | Open |
