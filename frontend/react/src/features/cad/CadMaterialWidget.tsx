/**
 * CAD-G1/CAD-G3 — the library-material picker (ADR 0388 P5).
 *
 * The plain `enum` widget was rendering the CATALOG IDS as option labels, so the
 * panel read `plastic-red` / `wood-oak` — kebab wire tokens, in English, in all
 * four locales. That is the same leak the slides definition fixed in its own
 * grade pass ("enum fields were leaking raw wire tokens as option labels"); cad
 * never did.
 *
 * It also makes a VISUAL choice legible: every catalog material carries a #hex
 * colour, so the resolved paint rides beside the select as a swatch instead of
 * the user picking a finish by name alone. The swatch colour comes from the
 * catalog — never authored here — which is what keeps the safe-paint grammar
 * intact (`cadMaterials.ts`: "#hex only … structurally incapable of smuggling a
 * URL").
 *
 * Clearing stays available: `materialId` is optional and a solid may fall back to
 * its inline colour/metallic/roughness.
 */
import { useTranslation } from 'react-i18next';
import type { PropertyWidgetProps } from '../../canvas/types.js';
import { getMaterial } from './cadMaterials.js';

export function CadMaterialWidget({ id, def, value, onChange }: PropertyWidgetProps): JSX.Element {
  const { t } = useTranslation('cad');
  const options = def.options ?? [];
  const current = typeof value === 'string' ? value : '';
  const swatch = getMaterial(current || undefined);
  return (
    <span className="cad-material">
      <select id={id} className="cv-editor__input" value={current} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('materialNone')}</option>
        {options.map((o) => <option key={o} value={o}>{t(`opt_materialId_${o}`, { defaultValue: o })}</option>)}
      </select>
      {swatch ? (
        <span
          className="cad-material__swatch"
          style={{ background: swatch.color }}
          // The colour is a restatement of the selected option, not information
          // of its own — naming it would just repeat the select to a screen
          // reader, and a hex code is not a useful thing to hear.
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}
