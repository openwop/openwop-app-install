-- Job-search live-data probes (DATA-ASSESSMENT-job-search-vertical §probes).
-- READ-ONLY. Run against the production Postgres (Cloud SQL) — e.g.:
--   gcloud sql connect <instance> --project openwop-dev --user <user> \
--     < scripts/job-search-prod-probes.sql
-- Every probe's EXPECTED result is 0; a non-zero count is a finding — file it
-- in the DATA assessment with the count and a sampled row (redact values).
--
-- Key shape note (the first version of this file got it wrong and would have
-- reported 100% orphaning on a healthy database): hostext keys are
-- `hostext:<namespace>:<id>` where <id> itself contains colons AND tenant ids
-- contain colons (`user:<hash>`, `anon:<sid>`, `ws:<uuid>`) — so NEVER
-- split_part a key to find a tenant/subject. Every row carries its fields in
-- the JSON value; extract from there.

-- JS-PROBE-1 — deal orphans: feature rows whose CRM deal is gone.
-- Deals live in the entities KERNEL (`hostext:entity:record:` rows with the
-- full deal under ext.deal); the legacy `hostext:crm:deal:` namespace may
-- still hold pre-migration rows — a deal is alive if EITHER matches.
WITH refs AS (
  SELECT (v::jsonb ->> 'tenantId') AS tenant, (v::jsonb ->> 'dealId') AS deal_id, k
  FROM host_ext_kv
  WHERE k LIKE 'hostext:job-search:followup:%'
     OR k LIKE 'hostext:job-search:draft:%'
     OR k LIKE 'hostext:job-search:digest:%'
)
SELECT count(*) AS js_probe_1_deal_orphans
FROM refs r
WHERE NOT EXISTS (
  SELECT 1 FROM host_ext_kv legacy
  WHERE legacy.k LIKE 'hostext:crm:deal:%'
    AND (legacy.v::jsonb ->> 'dealId') = r.deal_id
    AND (legacy.v::jsonb ->> 'tenantId') = r.tenant
)
AND NOT EXISTS (
  SELECT 1 FROM host_ext_kv kern
  WHERE kern.k LIKE 'hostext:entity:record:%'
    AND (kern.v::jsonb -> 'ext' -> 'deal' ->> 'dealId') = r.deal_id
    AND (kern.v::jsonb -> 'ext' -> 'deal' ->> 'tenantId') = r.tenant
);

-- JS-PROBE-2 — anonymous-principal rows: answer rows whose SUBJECT is an
-- anonymous principal should not exist (resolveCallerUser fails closed for
-- anonymous callers — this is the empirical check of that inference).
SELECT count(*) AS js_probe_2_anon_subject_rows
FROM host_ext_kv
WHERE k LIKE 'hostext:job-search:answer:%'
  AND (v::jsonb ->> 'subjectId') LIKE 'anon%';

-- JS-PROBE-3 — hash-index dangling: every attestation-hashidx row must point
-- at a live attestation. (Erasure deletes index rows with their records — the
-- JS-DATA-3 closure; a non-zero here predates it or found a new path.)
SELECT count(*) AS js_probe_3_dangling_hashidx
FROM host_ext_kv idx
WHERE idx.k LIKE 'hostext:job-search:attestation-hashidx:%'
  AND NOT EXISTS (
    SELECT 1 FROM host_ext_kv att
    WHERE att.k LIKE 'hostext:job-search:attestation:%'
      AND (att.v::jsonb ->> 'attestationId') = (idx.v::jsonb ->> 'attestationId')
      AND (att.v::jsonb ->> 'tenantId') = (idx.v::jsonb ->> 'tenantId')
  );

-- JS-PROBE-4 — special-category leakage: the store-level refusal
-- (specialCategoryKeyFor, re-checked by putAnswerRow) makes these rows
-- structurally unrepresentable; this is the empirical form of that claim.
SELECT count(*) AS js_probe_4_special_category
FROM host_ext_kv
WHERE k LIKE 'hostext:job-search:answer:%'
  AND lower(v::text) ~ '(disabilit|veteran|ethnicit)';
