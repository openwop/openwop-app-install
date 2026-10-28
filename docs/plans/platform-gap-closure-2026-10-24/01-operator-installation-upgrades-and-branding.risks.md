# Section 01 — Risk register

Status: Proposed mitigation plan; no risk is closed. Parent: [Operator installation, upgrades and complete branding](01-operator-installation-upgrades-and-branding.prd.md).

Likelihood/impact are qualitative judgments, not observed frequencies. High-risk review target **2026-10-31** is a proposed planning checkpoint, not a delivery commitment; staffing and review date need sponsor confirmation. David Tufts is the proposed accountable sponsor; the named functional role below is the proposed mitigation owner, not an assertion of assignment.

| ID | Risk | Likelihood | Impact | Priority | Mitigation | Proposed mitigation owner | Target / gate | State |
|---|---|---|---|---|---|---|---|---|
| S01-K1 | Unsafe mixed-version deployment despite metadata | M | H | High | Run old/new-binary compatibility fixtures; require real drain/restore rehearsal. 2026-10-24: the metadata half is in place (`rollingSafe`, planner says "stop the old binary" for any crossing of 0.2.0); the runtime guard and the fixtures are not, so the likelihood is unchanged | Release engineering / operator experience | 2026-10-31 review; before upgrade release | Open |
| S01-K2 | Secrets leak through generated config or test logs | M | H | High | Use refs/redaction canaries and isolated credentials; scan extracted bundles | Release engineering / operator experience | 2026-10-31 review; before external artifact publication | Open |
