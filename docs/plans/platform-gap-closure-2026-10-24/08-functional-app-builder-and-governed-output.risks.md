# Section 08 — Risk register

Status: Proposed mitigation plan; no risk is closed. Parent: [Functional app-builder output and governed deployment](08-functional-app-builder-and-governed-output.prd.md).

Likelihood/impact are qualitative judgments, not observed frequencies. High-risk review target **2026-10-31** is a proposed planning checkpoint, not a delivery commitment; staffing and review date need sponsor confirmation. David Tufts is the proposed accountable sponsor; the named functional role below is the proposed mitigation owner, not an assertion of assignment.

| ID | Risk | Likelihood | Impact | Priority | Mitigation | Proposed mitigation owner | Target / gate | State |
|---|---|---|---|---|---|---|---|---|
| S08-K1 | Generated app bypasses auth or exports credentials | M | H | High | Closed validated bindings, real negative auth tests, secret-canary scan and security review | App-builder / generated-runtime engineering | 2026-10-31 review; before deployable label | Open |
| S08-K2 | Approved artifact differs from deployed bytes | M | H | High | Hash-bound lineage/approval/deploy/smoke chain and target readback | App-builder / generated-runtime engineering | 2026-10-31 review; before deployment release | Open |
