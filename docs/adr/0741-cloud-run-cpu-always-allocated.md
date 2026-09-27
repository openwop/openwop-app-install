# ADR 0741 — Cloud Run CPU is always allocated: the background workers need it

Status: implemented (2026-09-22, rev `openwop-app-backend-00736-7m7`, commit `b5066568d`)

## Context — measured, not inferred

This service runs its own background work in-process: the webhook delivery
worker, the run-dispatch and orphan sweepers, retention, the heartbeat, and the
executor's own post-response dispatch (`setImmediate` after `POST /runs`
answers). With `run.googleapis.com/cpu-throttling: true`, Cloud Run gives an
instance CPU only while it is serving a request. Between requests these loops
barely advance.

MEASURED on production, the same no-op run (`conformance-noop`), server-side
event timestamps:

| | `run.started → run.completed` | before first `node.started` |
|---|---|---|
| throttled (rev `00727`, 2026-09-21, 4 samples) | 5.75 – 16.03 s | 3.3 – 9.8 s |
| always allocated (rev `00736`, 2026-09-22, 3 samples, DURING a load-test cut) | 0.14 – 0.28 s | 0.06 – 0.17 s |

The same starvation kept `openwop-core-standard` from certifying: webhook
deliveries arrived outside the suite's 20–30 s windows
(`0171.webhook-delivery-shape`, `0187.bound-id-kinds.webhook-emitted`). After the
switch, both passed.

A second hazard showed up once the switch was made. An instance of a revision
two deploys old (`00734-lts`) was still alive, with no traffic and still
throttled. Its delivery worker claimed the `0173.webhook-durable-delivery` rows
(each under a 120 s lease), sent attempts 1 and 2, then stalled with no CPU, so
the retries were stranded until the test timed out. Deleting that revision
removed it, and the next cut certified: **167 pass / 0 fail / 0 blocked**, with
`openwop-core-standard`, `discovery-core` and `conformance-seams-v2` all
certified.

## Decision

`--no-cpu-throttling` ("CPU always allocated") on `openwop-app-backend`. A bare
`gcloud run deploy` preserves it, as it preserves the rest of the live config
(CLAUDE.md).

Decided by the owner as a TRIAL with an explicit rule: keep it if
`openwop-core-standard` certifies, revert it if not. It certified.

**Cost.** One warm instance (`minScale 1`, 2 vCPU, 1 GiB) is now billed at the
always-allocated rate. The pre-trial estimate was about $60–100/month more than
the idle rate under throttling. This is an ESTIMATE, not a measurement: read
the next billing cycle. `maxScale` stays 3, so the ceiling is three instances,
and the Postgres budget (`pool 4 × maxScale 3 = 12 ≤ 22`, preflight Gate 5) is
unchanged.

## Alternatives weighed

- **Keep throttling and move delivery onto request CPU.** Deliver in-request, or
  from a Cloud Tasks / Scheduler ping. A larger change with no guarantee: the
  executor's own post-response dispatch is starved the same way, and that is the
  6–16 s run latency users see, not only the conformance rows.
- **Cloud Tasks / Pub/Sub push per delivery.** The right shape at scale; it is a
  new moving part and a new failure mode for a demo host with one warm instance.
  Revisit if the instance count grows.

## Consequences and follow-ups

- **Revert, if needed:** `gcloud run services update openwop-app-backend
  --cpu-throttling …`, then shift traffic BY NAME to the new revision (ADR 0631).
  The latency and delivery rows will regress with it.
- **`WHD-28`:** a revision's instance can outlive its traffic. While one does, it
  runs the same workers against the same queue. Throttled, it can hold a delivery
  lease it cannot service. With every new revision now unthrottled, a straggler
  would at least make progress, but it runs OLD code. The deploy recipe should
  confirm that superseded revisions have no live instances; a list of
  instance ids per revision from the logs is how it was seen here.
- `docs/steward/TODO.md` `WHD-16`: the queue side of the starvation. Pending rows
  of unregistered subscriptions were closed by #4083. This ADR is the CPU side.
