/**
 * `canvas.cad.bom` inline renderer (ADR 0388 P2) — a READ-ONLY bill-of-
 * materials table. The BOM is computed by the host (deterministic, zero-AI);
 * this renderer only displays the payload. Mesh volume rows carry a labeled
 * "approx." chip (signed-tetrahedron volume is exact only for closed meshes —
 * disclosed, never silent).
 */
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import { formatNumber } from '../../i18n/format.js';
import type { ArtifactRendererProps } from './rendererRegistry.js';

interface BomRow {
  label: string;
  kind: string;
  quantity: number;
  dimensions: Record<string, number>;
  material?: string;
  volume: number;
  area: number;
  volumeApprox?: boolean;
}

interface BomDoc {
  modelName?: string;
  units: string;
  rows: BomRow[];
  totals: {
    parts: number;
    volume: number;
    area: number;
    /** CAD2-R2 — TRUE when any row's volume is approximate. The per-row chip
     *  existed; the TOTAL printed a bare number, so the one figure a reader
     *  takes away claimed an exactness its own parts disclaimed. Closing this
     *  in the CSV alone would have left the in-app table — the only registered
     *  renderer for `canvas.cad.bom` — making the same claim. */
    volumeApprox?: boolean;
  };
}

function parseBom(content: string): BomDoc | null {
  try {
    const raw = JSON.parse(content) as BomDoc;
    if (!raw || !Array.isArray(raw.rows) || !raw.totals) return null;
    return raw;
  } catch {
    return null;
  }
}

export function BomPreview({ content }: ArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('cad');
  const bom = parseBom(content);
  if (!bom) return <Notice variant="error">{t('bomInvalid')}</Notice>;
  return (
    <figure className="canvas-cad">
      <div className="u-overflow-auto">
        <table className="data-table" data-density="compact">
          <caption className="sr-only">{t('bomCaption', { name: bom.modelName ? ` — ${bom.modelName}` : '' })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('bomColLabel')}</th>
              <th scope="col">{t('bomColKind')}</th>
              <th scope="col">{t('bomColQty')}</th>
              <th scope="col">{t('bomColDims')}</th>
              <th scope="col">{t('bomColMaterial')}</th>
              <th scope="col">{t('bomColVolume', { units: bom.units })}</th>
              <th scope="col">{t('bomColArea', { units: bom.units })}</th>
            </tr>
          </thead>
          <tbody>
            {bom.rows.map((row, i) => (
              <tr key={i}>
                <td>{row.label}</td>
                <td>{t(`kind_${row.kind}`, { defaultValue: row.kind })}</td>
                <td>{formatNumber(row.quantity)}</td>
                <td>{Object.entries(row.dimensions).map(([k, v]) => `${k}=${formatNumber(v)}`).join(' ')}</td>
                <td>{row.material ?? '—'}</td>
                <td>
                  {formatNumber(row.volume)}
                  {row.volumeApprox ? <span className="chip chip--muted u-ml-1">{t('bomApprox')}</span> : null}
                </td>
                <td>{formatNumber(row.area)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{t('bomTotal')}</th>
              <td>—</td>
              <td>{formatNumber(bom.totals.parts)}</td>
              <td>—</td>
              <td>—</td>
              <td>
                {formatNumber(bom.totals.volume)}
                {bom.totals.volumeApprox ? <span className="chip chip--muted u-ml-1">{t('bomApprox')}</span> : null}
              </td>
              <td>{formatNumber(bom.totals.area)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <figcaption className="canvas-cad__caption">
        {bom.modelName ? <span className="canvas-cad__name">{bom.modelName}</span> : null}
        <span className="canvas-cad__meta">{t('bomMeta', { parts: bom.totals.parts, units: bom.units })}</span>
      </figcaption>
    </figure>
  );
}
