/**
 * CAD editor assist drawer (ADR 0515) — the in-editor entry to the CAD
 * Modeler. It does NOT implement a chat: it owns ONLY the drawer chrome and
 * a canvasId-seeded empty state, and delegates the entire AI surface to the
 * shared <EmbeddedChatPanel> (chat/ — the ONE RFC 0005 conversation
 * primitive; BYOK gate, persistence, streaming, HITL cards all inherited).
 *
 * EmbeddedChatPanel is **lazy-imported**: chat/ statically imports
 * features/cad/ (CadPreview → Cad3dView), so a static cad→chat edge would
 * cycle (the builder precedent — CLAUDE.md import rule).
 *
 * Review posture (ADR 0515 §4): renders land in the SAME canvas via the
 * render tool's closed-world validate + CAS — visible live, reversible via
 * the editor's undo/collab history.
 */

import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';

const EmbeddedChatPanel = lazy(() =>
  import('../../chat/EmbeddedChatPanel.js').then((m) => ({ default: m.EmbeddedChatPanel })),
);

/** The ONE CAD agent (feature.cad.agents pack) — never a new persona. */
export const CAD_MODELER_AGENT_ID = 'feature.cad.agents.default';

function CadAssistWelcome({ canvasId, onPick }: { canvasId: string; onPick: (text: string) => void }): JSX.Element {
  const { t } = useTranslation('cad');
  // The examples CARRY the open canvas's id — that is the scoping mechanism
  // (get-design/render take canvasId), so the agent's read-before-write lands
  // on the model in front of the user.
  const examples = [
    t('assistExample1', { canvasId }),
    t('assistExample2', { canvasId }),
    t('assistExample3', { canvasId }),
  ];
  return (
    <div className="u-flex u-flex-col u-gap-2">
      <p className="muted u-fs-13 u-m-0">{t('assistWelcome')}</p>
      <div className="u-flex u-flex-col u-gap-1">
        {examples.map((ex) => (
          <Button key={ex} variant="quiet" className="u-text-left u-fs-13" onClick={() => onPick(ex)}>
            {ex}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function CadAssistPanel({ canvasId, onClose }: { canvasId: string; onClose(): void }): JSX.Element {
  const { t } = useTranslation('cad');
  return (
    <div className="cad-assist-drawer surface-card u-flex u-flex-col u-minh-0 u-gap-2" role="region" aria-label={t('assistHeading')}>
      <div className="u-flex u-items-center u-justify-between u-gap-2">
        <h3 className="u-m-0 u-fs-14">{t('assistHeading')}</h3>
        <Button variant="secondary" size="sm" onClick={onClose}>{t('assistClose')}</Button>
      </div>
      {/* The live-and-undoable contract, stated up front (ADR 0515 §4). */}
      <p className="muted u-fs-12 u-m-0">{t('assistHint')}</p>
      <Suspense fallback={<div className="muted u-fs-13 u-p-3">{t('assistLoading')}</div>}>
        <EmbeddedChatPanel
          agentId={CAD_MODELER_AGENT_ID}
          renderEmptyState={(onPick) => <CadAssistWelcome canvasId={canvasId} onPick={onPick} />}
        />
      </Suspense>
    </div>
  );
}
