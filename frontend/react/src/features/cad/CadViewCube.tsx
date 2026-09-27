/**
 * CAD-R2-1 — the orientation widget (view cube), the universal CAD standard
 * (Onshape/SketchUp/Tinkercad all ship one; our orbit view navigated blind).
 *
 * A CONTROLLED widget over the same `rotate(az, el)` the viewer projects
 * with, so the mini cube always shows the true orientation. Three parts, the
 * Onshape arrangement, all keyboard/SR-reachable:
 *   - the cube: each sufficiently front-facing face is a real button that
 *     snaps to that axis view (Top/Bottom keep the current yaw for context)
 *   - four 90° orbit arrows — they make EVERY view reachable from every
 *     state (at a snapped axis view the other faces are edge-on and
 *     therefore unclickable; the arrows are the way out of that dead end)
 *   - home — back to the ¾ starting view (HOME_AZ/HOME_EL)
 */
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { ArrowDownIcon, ArrowUpIcon, HomeIcon, RotateCcwIcon, RotateCwIcon } from '../../ui/icons/index.js';
import { EL_MAX, HOME_AZ, HOME_EL, rotate, shadeBrightness, type Vec3 } from './cad3d.js';

const SIZE = 84; // widget viewBox — rendered at a fixed small CSS size
const C = SIZE / 2;
const S = 17; // half-edge in widget px (cube diagonal √3·S stays inside)
/** Faces culled below this face-on threshold — an edge-on sliver is not an
 *  honest click target. */
const FACE_EPS = 0.15;
/** Labels only when the face is readable, not skewed to a ribbon. */
const LABEL_EPS = 0.55;

type Face = {
  key: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
  n: Vec3;
  /** The snap: absolute yaw, or keep-current-yaw for the vertical faces. */
  snap: (az: number) => { az: number; el: number };
};

const FACES: Face[] = [
  { key: 'front', n: { x: 0, y: 0, z: 1 }, snap: () => ({ az: 0, el: 0 }) },
  { key: 'back', n: { x: 0, y: 0, z: -1 }, snap: () => ({ az: Math.PI, el: 0 }) },
  { key: 'right', n: { x: 1, y: 0, z: 0 }, snap: () => ({ az: -Math.PI / 2, el: 0 }) },
  { key: 'left', n: { x: -1, y: 0, z: 0 }, snap: () => ({ az: Math.PI / 2, el: 0 }) },
  { key: 'top', n: { x: 0, y: 1, z: 0 }, snap: (az) => ({ az, el: EL_MAX }) },
  { key: 'bottom', n: { x: 0, y: -1, z: 0 }, snap: (az) => ({ az, el: -EL_MAX }) },
];

/** A face's 4 corners: center ± the two axes orthogonal to its normal. */
function corners(n: Vec3): Vec3[] {
  const u: Vec3 = n.x !== 0 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const v: Vec3 = n.y !== 0 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const at = (su: number, sv: number): Vec3 => ({
    x: (n.x + su * u.x + sv * v.x) * S,
    y: (n.y + su * u.y + sv * v.y) * S,
    z: (n.z + su * u.z + sv * v.z) * S,
  });
  return [at(1, 1), at(-1, 1), at(-1, -1), at(1, -1)];
}

const clampEl = (el: number): number => Math.max(-EL_MAX, Math.min(EL_MAX, el));

export function CadViewCube({ az, el, onView }: {
  az: number;
  el: number;
  onView: (az: number, el: number) => void;
}): JSX.Element {
  const { t } = useTranslation('cad');
  const project = (p: Vec3): { x: number; y: number } => {
    const r = rotate(p, az, el);
    return { x: C + r.x, y: C - r.y };
  };
  // Paint back→front so the visible faces sit on top of culled-face strokes.
  const faces = FACES
    .map((f) => ({ f, rn: rotate(f.n, az, el) }))
    .sort((a, b) => a.rn.z - b.rn.z);
  const quarter = Math.PI / 2;
  return (
    <div className="cad-viewcube">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="cad-viewcube__cube" role="group" aria-label={t('viewCubeLabel')}>
        {faces.map(({ f, rn }) => {
          if (rn.z <= FACE_EPS) return null;
          const pts = corners(f.n).map(project).map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`).join(' ');
          const label = t(`viewCube_${f.key}`);
          const center = project({ x: f.n.x * S, y: f.n.y * S, z: f.n.z * S });
          const snap = (): void => { const v = f.snap(az); onView(v.az, v.el); };
          return (
            <g key={f.key}>
              <polygon
                points={pts}
                role="button"
                tabIndex={0}
                aria-label={t('viewCubeFaceAria', { view: label })}
                style={{ fill: 'var(--paper-2)', filter: `brightness(${Math.round(shadeBrightness(rn, { metallic: 0.1, roughness: 0.8 }) * 1000) / 1000})` }}
                onClick={snap}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); snap(); } }}
              />
              {rn.z > LABEL_EPS ? (
                <text x={center.x} y={center.y} fontSize={8} className="cad-viewcube__face-label" textAnchor="middle" dominantBaseline="middle" aria-hidden="true">
                  {label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="cad-viewcube__controls">
        {/* Directions mirror the viewer's OWN keyboard arrows (ArrowLeft = az−,
            ArrowUp = el−) so pointer and keyboard users learn ONE mapping. */}
        <Button variant="quiet" size="sm" aria-label={t('viewCubeYawLeft')} onClick={() => onView(az - quarter, el)}><RotateCcwIcon /></Button>
        <Button variant="quiet" size="sm" aria-label={t('viewCubePitchUp')} onClick={() => onView(az, clampEl(el - quarter))}><ArrowUpIcon /></Button>
        <Button variant="quiet" size="sm" aria-label={t('viewCubeYawRight')} onClick={() => onView(az + quarter, el)}><RotateCwIcon /></Button>
        <Button variant="quiet" size="sm" aria-label={t('viewCubeHome')} onClick={() => onView(HOME_AZ, HOME_EL)}><HomeIcon /></Button>
        <Button variant="quiet" size="sm" aria-label={t('viewCubePitchDown')} onClick={() => onView(az, clampEl(el + quarter))}><ArrowDownIcon /></Button>
      </div>
    </div>
  );
}
