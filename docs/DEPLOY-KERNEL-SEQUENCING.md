# Deploy sequencing — the content-kernel migration follow-ons (KERNEL-6 + LEGACY-CLEANUP)

**Status:** prepared, DEPLOY-GATED — do NOT merge the migrations below into `main`
until the one-content-kernel program (ADR 0408/0409/0410, `APP_MIGRATIONS` 9–12)
has **deployed and served 100% traffic**. Owner: whoever runs the deploy after the
program's. Cross-refs: ADR 0409, ADR 0410, `docs/steward/CODEBASE-ASSESSMENT.md` (`KERNEL-6`,
`LEGACY-CLEANUP`), the v8 precedent (`appMigrations.ts` — `rekey-…-post-rollout-resweep`).

## Why these can't ship with the program

`APP_MIGRATIONS` run **in ascending order in one boot**. The re-sweep and the
legacy-clear both defend against — or depend on — the program's **rollout window**
(the interval during the program's own deploy when old instances still write the
legacy stores while new instances read the kernel). A migration that runs *in the
same boot* as migs 9–12 runs *before* that window exists, so:

- **The re-sweep would no-op** against an as-yet-identical legacy/kernel and there
  would be **no later migration to catch the actual stragglers** — this is exactly
  the v5+v6+v7-shipped-together mistake the v8 note documents.
- **The legacy-clear would delete the rollback copy** in the very release that first
  reads the kernel, and would also delete the stragglers before the re-sweep can
  drain them.

So both land in the **first release AFTER the program's deploy** ("Release B"). By
then every instance reads/writes the kernel and the legacy stores are **frozen**, so
Release B has no straggler window of its own — the re-sweep (mig 13) can drain
Release-A stragglers and the legacy-clear (mig 14) can delete the drained legacy in
the **same** Release B, in that order.

## The straggler being fixed (why skip-if-present is not enough)

During the program's rollout an old instance may:
- **create** a row → lands only in legacy, absent from the kernel → the plain
  skip-if-present migrate *does* copy it. ✅
- **update** a row already copied by mig 9–12 → legacy row is now newer than the
  kernel row, but its id is present → skip-if-present **skips it, losing the update**. ❌

The re-sweep therefore uses **`updatedAt`-newer-wins**, already implemented and
tested as `makeKernelAdapter`'s `migrate({ overwriteIfNewer: true })`
(`kernel-adapter.test.ts`).

---

## Release B, step 1 — KERNEL-6 re-sweep (mig 13)

### 1a. Export a re-sweep per façade

`crm/entities/companies.ts`, `crm/entities/deals.ts`, `commerce/commerceService.ts`
each already hold the private `companies`/`deals`/`products` adapter — add:

```ts
// companies.ts
export async function resweepCompaniesToKernel() { return companies.migrate({ overwriteIfNewer: true }); }
// deals.ts
export async function resweepDealsToKernel() { return deals.migrate({ overwriteIfNewer: true }); }
// commerceService.ts
export async function resweepProductsToKernel() { return products.migrate({ overwriteIfNewer: true }); }
```

`cms.page` needs a **custom** re-sweep because its initial migration also seeds a
scheduled-publish marker — mirror `migratePagesToKernel` with newer-wins so a
straggler page still gets its marker (`cms/cmsService.ts`):

```ts
export async function resweepPagesToKernel(): Promise<{ migrated: number; skipped: number; updated: number }> {
  let migrated = 0, skipped = 0, updated = 0;
  for (const page of await legacyPages.list()) {
    const existing = await pages.get(page.tenantId, page.pageId);
    if (existing) {
      // Update-straggler: reconcile only when legacy is strictly newer.
      if (page.updatedAt > existing.updatedAt) { await pages.put(page); updated += 1; }
      else { skipped += 1; continue; }
    } else {
      await pages.put(page); migrated += 1;
    }
    if (page.scheduledPublishAt && (page.status === 'draft' || page.status === 'in_review')) {
      await scheduledMarkers.put({ pageId: page.pageId, tenantId: page.tenantId, orgId: page.orgId, at: page.scheduledPublishAt });
    }
  }
  if (migrated + updated > 0) log.info('cms_pages_resweep', { migrated, skipped, updated });
  return { migrated, skipped, updated };
}
```

### 1b. One combined migration entry (`appMigrations.ts`, `version: 13`)

```ts
{
  // KERNEL-6 (deploy+1) — the post-rollout straggler re-sweep. Reconciles any
  // legacy row an old instance wrote DURING the program's (migs 9–12) rollout:
  // new rows are copied, updated rows are overwritten IFF legacy is newer
  // (updatedAt-newer-wins). Clean stores ⇒ no-op. MUST ship the release AFTER
  // the program's deploy (see docs/DEPLOY-KERNEL-SEQUENCING.md).
  version: 13,
  name: 'content-kernel-post-rollout-resweep',
  async run(): Promise<void> {
    await resweepPagesToKernel();
    await resweepCompaniesToKernel();
    await resweepDealsToKernel();
    await resweepProductsToKernel();
  },
},
```

---

## Release B, step 2 — LEGACY-CLEANUP (mig 14)

Runs **after** mig 13 in the same boot (the re-sweep has drained legacy; the
read-dark rollback window has closed with Release A serving 100%).

### 2a. Export a legacy-only clear per façade

The adapter's `__clear()` wipes BOTH the kernel and the legacy store — **do not use
it here.** Clear ONLY the frozen legacy store:

```ts
// each façade, next to its legacy DurableCollection:
export async function clearLegacyCompanies() { await legacyCompanies.__clear(); }
export async function clearLegacyDeals()     { await legacyDeals.__clear(); }
export async function clearLegacyProducts()  { await legacyProducts.__clear(); }
export async function clearLegacyPages()     { await legacyPages.__clear(); }
```

### 2b. Migration entry (`appMigrations.ts`, `version: 14`)

```ts
{
  // LEGACY-CLEANUP (deploy+1, AFTER mig 13) — delete the read-dark legacy stores
  // now that every row lives in the kernel and the rollback window has closed.
  // Kernel rows are untouched (this clears ONLY crm:company / crm:deal /
  // commerce:product / cms:page legacy). See docs/DEPLOY-KERNEL-SEQUENCING.md.
  version: 14,
  name: 'content-kernel-drop-legacy-stores',
  async run(): Promise<void> {
    await clearLegacyPages();
    await clearLegacyCompanies();
    await clearLegacyDeals();
    await clearLegacyProducts();
  },
},
```

---

## Arming checklist (Release B PR)

- [ ] Confirm the program (migs 9–12) has deployed and the Cloud Run revision serves
      **100%** traffic (rollback window is the operator's call — default ≥ 1 release).
- [ ] Add the `resweep*`/`clearLegacy*` exports (§1a, §2a).
- [ ] Add migrations **13 then 14** in that order (§1b, §2b).
- [ ] `node scripts/check-migration-integrity.mjs` green (contiguous 9→14).
- [ ] `check-migration-integrity` + `app-version-migrations` accept 13 + 14.
- [ ] After Release B serves 100%, the legacy stores are gone — run the DATA-ASSESSMENT
      `KERNEL-6`/`LEGACY-CLEANUP` probes to confirm 0 legacy rows + 0 guard-blind orphans.
- [ ] Mark `KERNEL-6` + `LEGACY-CLEANUP` closed in `docs/steward/CODEBASE-ASSESSMENT.md` / `docs/steward/DATA-ASSESSMENT.md`.

> Do NOT merge migrations 13/14 before the program deploys. The re-sweep logic is
> already built + tested (`makeKernelAdapter.migrate({overwriteIfNewer})`); only the
> migration ENTRIES are gated.
