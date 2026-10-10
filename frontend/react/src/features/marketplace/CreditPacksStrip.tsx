/**
 * ADR 0821 D1/D7 — the store's "AI credits" strip: the operator's configured
 * one-time credit packs (`GET …/billing/token-packs`).
 *
 * Honest by construction:
 *  - renders NOTHING unless at least one pack is configured (or the read fails —
 *    an add-on strip is never worth an error card on the store);
 *  - a pack whose display copy has no `price` lists its credits and offers no buy
 *    button (MKT-UX-6: a money action is never offered without its amount);
 *  - buy buttons only for a caller who may manage billing (the server refuses
 *    anyone else with 403 regardless);
 *  - the buy names an OPAQUE `packKey`, never a Stripe price (ADR 0419).
 * The page owns the checkout round trip (one in flight at a time) and the
 * `?checkout=` return.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { formatNumber } from '../../i18n/format.js';
import { getTokenPacks, type TokenPack } from '../billing/billingClient.js';

export interface CreditPacksStripProps {
  /** Billing is on for this workspace (the read 404s otherwise). */
  enabled: boolean;
  /** The caller may manage billing (`host:billing:manage`). */
  canBuy: boolean;
  /** The checkout key in flight, if any (`pack:<packKey>` for this strip). */
  buying: string | null;
  onBuy: (packKey: string) => void;
}

export function CreditPacksStrip({ enabled, canBuy, buying, onBuy }: CreditPacksStripProps): JSX.Element | null {
  const { t } = useTranslation('marketplace');
  const [packs, setPacks] = useState<TokenPack[]>([]);
  useEffect(() => {
    if (!enabled) { setPacks([]); return; }
    let live = true;
    void getTokenPacks().then((p) => { if (live) setPacks(p); }).catch(() => { if (live) setPacks([]); });
    return () => { live = false; };
  }, [enabled]);

  if (!enabled || packs.length === 0) return null;
  return (
    <section className="surface-card fstore-credits" aria-labelledby="store-credits-h">
      <div className="fstore-credits__intro">
        <h2 id="store-credits-h" className="u-m-0">{t('storeCreditsTitle')}</h2>
        <p className="u-m-0 u-text-sm muted">{t('storeCreditsLede')}</p>
        {!canBuy ? <p className="u-m-0 u-text-sm muted">{t('storeCreditsAdminsOnly')}</p> : null}
      </div>
      <ul className="fstore-credits__packs">
        {packs.map((p) => {
          const credits = formatNumber(p.credits, { maximumFractionDigits: 2 });
          const price = p.priceDisplay?.price;
          const label = p.priceDisplay?.label;
          return (
            <li key={p.packKey} className="fstore-pack">
              <strong className="fstore-pack__credits">{t('storeCreditsAmount', { count: p.credits, credits })}</strong>
              {label ? <span className="chip chip--accent">{label}</span> : null}
              {canBuy && price ? (
                <Button variant="secondary" disabled={buying !== null} onClick={() => onBuy(p.packKey)}>
                  {buying === `pack:${p.packKey}` ? t('buying') : t('storeCreditsBuy', { count: p.credits, credits, price })}
                </Button>
              ) : price ? <span className="u-text-sm muted">{price}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
