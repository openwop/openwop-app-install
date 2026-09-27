/**
 * CDP-1d — RFC 0128 (Draft) purpose-propagation conformance seam.
 *
 * `POST /v1/host/sample/purpose-propagation/forward` — the hop-B capture point the steward's
 * two-hop `purpose-propagation-onward` scenario drives: a labelled record (or a merge set)
 * goes in; the seam returns what hop C WOULD receive on each OpenWOP-envelope surface
 * (`a2a` / `trigger`) plus the records refused onward per the `[]` rule. It is a pure
 * projection over the tested `purposeLabels` algebra — it computes the onward label; it does
 * not dispatch (the observable promise is the LABEL, not a delivery).
 *
 * Flag-gated: 404 when `OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED` is off, so a pre-impl host
 * soft-skips; once `purposePropagation.supported` is advertised (post-Accepted flip) the
 * scenario forbids soft-skip (advertise-only-what-you-honor).
 */
import type { Express, Request, Response } from 'express';
import { normalizeLabel, isNoOnwardUse, reEmitLabel, intersectLabels } from '../features/cdp/purposeLabels.js';
import { purposePropagationEnabled } from '../features/destination-sync/destinationSyncService.js';

const SURFACES = ['a2a', 'trigger'] as const;

interface ForwardRecord {
  id?: string;
  permittedPurposes?: unknown;
  data?: unknown;
}

export function registerPurposePropagationSeamRoutes(app: Express): void {
  app.post('/v1/host/sample/purpose-propagation/forward', (req: Request, res: Response) => {
    if (!purposePropagationEnabled()) {
      res.status(404).json({ error: 'not_found', message: 'purpose-propagation seam disabled (RFC 0128 Draft, flag off)' });
      return;
    }
    const body = (req.body ?? {}) as { mode?: unknown; records?: unknown };
    const mode = body.mode === 'merge' ? 'merge' : body.mode === 'forward' ? 'forward' : null;
    if (!mode || !Array.isArray(body.records)) {
      res.status(400).json({ error: 'validation_error', message: '`mode` must be "forward"|"merge" and `records` an array.' });
      return;
    }
    const records = body.records as ForwardRecord[];

    if (mode === 'forward') {
      const onward: { recordId?: string; surface: string; permittedPurposes?: string[] }[] = [];
      const dropped: string[] = [];
      for (const r of records) {
        const label = normalizeLabel(r.permittedPurposes);
        if (isNoOnwardUse(label)) {
          dropped.push(r.id ?? ''); // [] = no onward use → refused on ALL surfaces
          continue;
        }
        const onwardLabel = reEmitLabel(label); // carry the inbound grant (never widens)
        for (const surface of SURFACES) {
          onward.push({ ...(r.id !== undefined ? { recordId: r.id } : {}), surface, ...(onwardLabel !== undefined ? { permittedPurposes: onwardLabel } : {}) });
        }
      }
      res.json({ onward, dropped });
      return;
    }

    // merge: N records → ONE derived output = the intersection (the only never-widening
    // composition). A `[]` among the inputs is contagious ⇒ the derived output is refused.
    const merged = intersectLabels(records.map((r) => normalizeLabel(r.permittedPurposes)));
    if (isNoOnwardUse(merged)) {
      res.json({ onward: [], dropped: records.map((r) => r.id ?? '') });
      return;
    }
    const onward = SURFACES.map((surface) => ({ surface, ...(merged !== undefined ? { permittedPurposes: merged } : {}) }));
    res.json({ onward, dropped: [] });
  });
}
