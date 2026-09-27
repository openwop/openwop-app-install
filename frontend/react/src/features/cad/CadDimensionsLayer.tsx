/**
 * Dimension annotations over the orthographic projection (ADR 0388 P3).
 * Values are DERIVED via the cadDims twin at render — never stored. Rendering
 * scope (recorded in the ADR): linear x/y draw measured extension lines;
 * everything else (z, radial/diameter/angular/arc/ordinate) renders as a
 * stacked value chip near the solid — honest, not pretended draughting. A
 * dimension whose target is out of range or unmeasurable renders nothing
 * (tolerant-on-read; the validator blocks new ones at save).
 */
import { useTranslation } from 'react-i18next';
import { cadFootprint, type CadProjection } from '../../chat/artifacts/CadPreview.js';
import { deriveDimensionValue, formatDimension, type CadDimension } from './cadDims.js';
import { peekMesh } from './meshStore.js';

interface SolidRead extends Record<string, unknown> { kind?: unknown; assetRef?: unknown }

export function CadDimensionsLayer({
  solids,
  dimensions,
  units,
  proj,
}: {
  solids: SolidRead[];
  dimensions: CadDimension[];
  units: string;
  proj: CadProjection;
}): JSX.Element | null {
  const { t } = useTranslation('cad');
  if (dimensions.length === 0) return null;
  const chipStack = new Map<number, number>(); // solid index → chips placed
  return (
    <g className="canvas-cad__dims" aria-label={t('col_dimensions')}>
      {dimensions.map((dim, i) => {
        const s = solids[dim.solid];
        if (!s || typeof s !== 'object') return null; // orphan ref — tolerant
        const meshExtent = (axis: 'x' | 'y' | 'z'): number | null => {
          const ref = typeof s.assetRef === 'string' ? s.assetRef : '';
          const entry = ref ? peekMesh(ref) : undefined;
          if (!entry?.meta) return null;
          const a = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
          return (entry.meta.bbox.max[a] ?? 0) - (entry.meta.bbox.min[a] ?? 0);
        };
        const value = deriveDimensionValue(s, dim, meshExtent);
        if (value === null) return null; // unmeasurable — never a fake number
        const text = `${dim.label ? `${dim.label}: ` : ''}${formatDimension(value, dim, units)}`;
        const f = cadFootprint(s);
        const left = proj.sx(f.x);
        const right = proj.sx(f.x + f.w);
        const bottom = proj.sy(f.y);
        const top = bottom - f.h * proj.scale;

        if (dim.kind === 'linear' && dim.axis === 'x') {
          const y = bottom + 10;
          return (
            <g key={i}>
              <line x1={left} y1={bottom + 3} x2={left} y2={y + 3} stroke="currentColor" strokeWidth={0.5} />
              <line x1={right} y1={bottom + 3} x2={right} y2={y + 3} stroke="currentColor" strokeWidth={0.5} />
              <line x1={left} y1={y} x2={right} y2={y} stroke="currentColor" strokeWidth={0.75} />
              <text x={(left + right) / 2} y={y + 9} textAnchor="middle" fontSize={8} fill="currentColor">{text}</text>
            </g>
          );
        }
        if (dim.kind === 'linear' && dim.axis === 'y') {
          const x = right + 10;
          return (
            <g key={i}>
              <line x1={right + 3} y1={top} x2={x + 3} y2={top} stroke="currentColor" strokeWidth={0.5} />
              <line x1={right + 3} y1={bottom} x2={x + 3} y2={bottom} stroke="currentColor" strokeWidth={0.5} />
              <line x1={x} y1={top} x2={x} y2={bottom} stroke="currentColor" strokeWidth={0.75} />
              <text x={x + 3} y={(top + bottom) / 2} fontSize={8} fill="currentColor" dominantBaseline="middle">{text}</text>
            </g>
          );
        }
        // Everything else: a stacked value chip below the footprint centre.
        const stack = chipStack.get(dim.solid) ?? 0;
        chipStack.set(dim.solid, stack + 1);
        return (
          <text key={i} x={(left + right) / 2} y={bottom + 20 + stack * 10} textAnchor="middle" fontSize={8} fill="currentColor">
            {text}
          </text>
        );
      })}
    </g>
  );
}
