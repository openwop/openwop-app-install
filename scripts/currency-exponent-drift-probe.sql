-- Currency-exponent drift probe (the #5211 follow-up). READ-ONLY: SELECTs only.
--
-- Until #5211 and its follow-up, money exponents came from Intl, whose display
-- precision on ICU 78.3 (Node 22.23.4, and current browsers on CLDR 48) is 0 for
-- the fifteen currencies below, where ISO 4217 says 2 (IQD: 3). A minor-unit amount
-- written through that path may be in WHOLE units, not ISO minor units. This counts
-- the stored rows that could be affected, by collection, currency and month, so a
-- person can decide whether anything needs migrating. It changes nothing.
--
-- Run against the production Postgres, e.g. through cloud-sql-proxy, and report the
-- counts only: never values, tenant ids or names.
--
-- Collections (DurableCollection rows in host_ext_kv, `hostext:<name>:<id>`):
--   campaign-brief:brief / :briefversion      budget.totalMinor (versions: snapshot.budget) (minor; written by the brief editor)
--   campaign-orchestration:campaign / :campaignversion   budget.totalMinor (minor; copied from the brief)
--   campaign-intel:spend-cap                  limitMinor (minor; API caller supplies it)
--   crm:territory-quota                       amount (MAJOR; only rounding was affected)
--   commissions:commission-statement          lines/total (MAJOR, rounded at write)

WITH drift(code) AS (
  VALUES ('AFN'), ('ALL'), ('COP'), ('HUF'), ('IDR'), ('IQD'), ('IRR'), ('LAK'),
         ('LBP'), ('MGA'), ('MMK'), ('PKR'), ('SOS'), ('SYP'), ('YER')
),
rows AS (
  SELECT split_part(k, ':', 2) || ':' || split_part(k, ':', 3) AS collection,
         CASE
           WHEN k LIKE 'hostext:campaign-brief:brief%' OR k LIKE 'hostext:campaign-orchestration:campaign%'
             THEN upper(coalesce(v::jsonb #>> '{budget,currency}', v::jsonb #>> '{snapshot,budget,currency}'))
           ELSE upper(v::jsonb ->> 'currency')
         END AS currency,
         left(coalesce(v::jsonb ->> 'createdAt', v::jsonb ->> 'updatedAt', ''), 7) AS month
  FROM host_ext_kv
  WHERE k LIKE 'hostext:campaign-brief:brief:%'
     OR k LIKE 'hostext:campaign-brief:briefversion:%'
     OR k LIKE 'hostext:campaign-orchestration:campaign:%'
     OR k LIKE 'hostext:campaign-orchestration:campaignversion:%'
     OR k LIKE 'hostext:campaign-intel:spend-cap:%'
     OR k LIKE 'hostext:crm:territory-quota:%'
     OR k LIKE 'hostext:commissions:commission-statement:%'
)
SELECT collection, currency, month, count(*) AS rows
FROM rows
WHERE currency IN (SELECT code FROM drift)
GROUP BY collection, currency, month
ORDER BY collection, currency, month;

-- Denominator: how many rows of each collection carry ANY currency, so a zero above
-- reads as "none in a drifting currency", not "the probe matched nothing".
SELECT split_part(k, ':', 2) || ':' || split_part(k, ':', 3) AS collection,
       count(*) AS rows,
       count(*) FILTER (WHERE coalesce(v::jsonb #>> '{budget,currency}', v::jsonb #>> '{snapshot,budget,currency}', v::jsonb ->> 'currency') IS NOT NULL) AS with_currency
FROM host_ext_kv
WHERE k LIKE 'hostext:campaign-brief:brief:%'
   OR k LIKE 'hostext:campaign-brief:briefversion:%'
   OR k LIKE 'hostext:campaign-orchestration:campaign:%'
   OR k LIKE 'hostext:campaign-orchestration:campaignversion:%'
   OR k LIKE 'hostext:campaign-intel:spend-cap:%'
   OR k LIKE 'hostext:crm:territory-quota:%'
   OR k LIKE 'hostext:commissions:commission-statement:%'
GROUP BY 1
ORDER BY 1;
