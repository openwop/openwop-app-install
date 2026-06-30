/**
 * canvas.app-builder inline renderer (ADR 0153 Phase 2). Renders a structured app
 * design — the `canvas.app-builder` artifact payload — inline in the chat artifact
 * workbench: each screen as a framed device preview of its component tree, plus the
 * navigation connectors. READ-ONLY here (drag-and-drop editing is the full-screen
 * editor, Phase 2b), so the registry registration is not `editable`.
 *
 * SAFETY: the component tree is approximated from a CLOSED set of host components —
 * every text value is React-escaped, images use a plain <img src>, and an unknown
 * component `type` renders as an inert labeled placeholder. No untrusted HTML, no
 * code execution (the constrained-JSON-vs-pinned-catalog model, ADR 0153 §R4).
 */

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import type { ArtifactRendererProps } from './rendererRegistry.js';

interface CompNode { type: string; props?: Record<string, unknown>; children?: CompNode[] }
interface Screen { id: string; name: string; route?: string; isInitial?: boolean; components?: CompNode[] }
interface Connector { from: string; to: string; trigger?: string; label?: string }
interface App { name: string; description?: string; theme?: string; screens: Screen[]; connectors?: Connector[] }

const MAX_DEPTH = 20;

function pstr(props: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = props?.[key];
  return typeof v === 'string' ? v : undefined;
}

function parseApp(content: string): App | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !Array.isArray(o.screens)) return null;
  return raw as App;
}

/** Render one component node from the closed catalog. Unknown types → inert placeholder. */
function CompView({ node, depth }: { node: CompNode; depth: number }): JSX.Element {
  if (depth > MAX_DEPTH) return <></>;
  const p = node.props;
  const kids = Array.isArray(node.children) ? node.children : [];
  const childEls = kids.map((c, i) => <CompView key={i} node={c} depth={depth + 1} />);
  switch (node.type) {
    case 'stack':
      return <div className={`canvas-ab__stack canvas-ab__stack--${pstr(p, 'direction') === 'horizontal' ? 'h' : 'v'}`}>{childEls}</div>;
    case 'grid':
      return <div className="canvas-ab__grid">{childEls}</div>;
    case 'card':
      return <div className="canvas-ab__card">{pstr(p, 'title') ? <div className="canvas-ab__card-title">{pstr(p, 'title')}</div> : null}{childEls}</div>;
    case 'list':
      return <div className="canvas-ab__list">{childEls}</div>;
    case 'heading': {
      const level = pstr(p, 'level');
      return <div className={`canvas-ab__heading canvas-ab__heading--${level === '1' ? '1' : level === '3' ? '3' : '2'}`}>{pstr(p, 'text') ?? ''}</div>;
    }
    case 'text':
      return <p className="canvas-ab__text">{pstr(p, 'text') ?? ''}</p>;
    case 'badge':
      return <span className={`chip canvas-ab__badge canvas-ab__badge--${pstr(p, 'variant') ?? 'neutral'}`}>{pstr(p, 'text') ?? ''}</span>;
    case 'divider':
      return <hr className="canvas-ab__divider" />;
    case 'image':
      return <img className="canvas-ab__image" src={pstr(p, 'src') ?? ''} alt={pstr(p, 'alt') ?? ''} loading="lazy" />;
    case 'button':
      return <span className={`canvas-ab__button canvas-ab__button--${pstr(p, 'variant') ?? 'primary'}`}>{pstr(p, 'label') ?? ''}</span>;
    case 'textInput':
      return <span className="canvas-ab__field">{pstr(p, 'label') ? <span className="canvas-ab__field-label">{pstr(p, 'label')}</span> : null}<span className="canvas-ab__input">{pstr(p, 'placeholder') ?? ''}</span></span>;
    case 'select':
      return <span className="canvas-ab__field">{pstr(p, 'label') ? <span className="canvas-ab__field-label">{pstr(p, 'label')}</span> : null}<span className="canvas-ab__input canvas-ab__input--select">{pstr(p, 'placeholder') ?? '▾'}</span></span>;
    case 'checkbox':
      return <span className="canvas-ab__checkbox"><span className="canvas-ab__checkbox-box" aria-hidden="true" /> {pstr(p, 'label') ?? ''}</span>;
    case 'link':
      return <span className="canvas-ab__link">{pstr(p, 'label') ?? ''}</span>;
    default:
      return <span className="canvas-ab__unknown">{node.type}</span>;
  }
}

/** The pure deck rendering (no chrome) — shared by the inline chat card and the
 *  full-screen editor's live preview (ADR 0153 Phase 2b), so there is ONE renderer. */
export function AppBuilderContentView({ content }: { content: string }): JSX.Element {
  const { t } = useTranslation('chat');
  const app = parseApp(content);
  if (!app) return <Notice variant="error">{t('appBuilderInvalid')}</Notice>;
  const theme = app.theme && app.theme.trim() ? app.theme : 'default';
  return (
    <div className="canvas-ab" data-theme={theme}>
      <div className="canvas-ab__head">
        <h3 className="canvas-ab__app-name">{app.name}</h3>
        {app.description ? <p className="canvas-ab__app-desc">{app.description}</p> : null}
      </div>
      <ol className="canvas-ab__screens" aria-label={t('appBuilderScreensLabel')}>
        {app.screens.map((screen) => (
          <li key={screen.id} className="canvas-ab__screen">
            <div className="canvas-ab__screen-bar">
              <span className="canvas-ab__screen-name">{screen.name}</span>
              {screen.isInitial ? <span className="chip chip--accent canvas-ab__home">{t('appBuilderInitial')}</span> : null}
              {screen.route ? <span className="canvas-ab__screen-route">{screen.route}</span> : null}
            </div>
            <div className="canvas-ab__device">
              {(screen.components ?? []).map((c, i) => <CompView key={i} node={c} depth={0} />)}
            </div>
          </li>
        ))}
      </ol>
      {app.connectors && app.connectors.length ? (
        <div className="canvas-ab__flows">
          <span className="canvas-ab__flows-label">{t('appBuilderFlowsLabel')}</span>
          <ul className="canvas-ab__flow-list">
            {app.connectors.map((c, i) => (
              <li key={i} className="canvas-ab__flow">{c.label ? `${c.label}: ` : ''}{c.from} → {c.to}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** The chat inline renderer: the read-only deck + an "Open in editor" entry (ADR 0153
 *  Phase 2b) that deep-links to the full-screen editor, seeding an editable working copy
 *  from THIS run artifact (keyed by its provenance runId:nodeId — replay-safe; the
 *  artifact itself is never mutated). */
export function AppBuilderPreview({ artifact, content }: ArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const { runId, nodeId } = artifact.provenance ?? {};
  const canEdit = Boolean(runId && nodeId);
  return (
    <div className="canvas-ab-card">
      {canEdit ? (
        <div className="canvas-ab-card__bar">
          <button type="button" className="secondary btn-sm" onClick={() => navigate(`/app-builder/new?fromArtifact=${encodeURIComponent(`${runId}:${nodeId}`)}`)}>
            {t('appBuilderOpenEditor')}
          </button>
        </div>
      ) : null}
      <AppBuilderContentView content={content} />
    </div>
  );
}
