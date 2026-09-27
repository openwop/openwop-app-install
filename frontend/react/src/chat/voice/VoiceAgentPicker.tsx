/**
 * Voice agent picker (ADR 0199 Phase 3 / ADR 0304 P2) — shown when the mic starts a
 * live session in an UNSCOPED chat. An unscoped realtime session has no persona, no
 * memories, and (tool allowlists being per-agent) no tools — so instead of silently
 * starting a context-blind conversation, ask who to talk to. The choice is remembered
 * per conversation; "workspace assistant" is the explicit generic option (labeled,
 * not silent). Agent-scoped chats never see this.
 *
 * ADR 0304 — a Board of Advisors is a first-class voice target: picking one starts
 * the live boardroom (the walkie multi-speaker loop over the board cadence), so the
 * picker lists visible boards alongside roster agents. Boards load via the existing
 * RBAC'd `listBoards` and degrade to absent when the advisory-board feature is off.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { MicIcon, BotIcon, UsersIcon } from '../../ui/icons/index.js';
import { listRoster, type RosterEntry } from '../../agents/rosterClient.js';
import { listBoards, type AdvisoryBoard } from '../../features/advisory-board/advisoryBoardClient.js';

const REMEMBER_PREFIX = 'owp.voice.agentFor:';
/** Stored-value marker for a board target (`board|<handle>|<boardId>` — handles are
 *  URL-safe, so `|` never collides; plain values stay the legacy agent encoding). */
const BOARD_MARK = 'board|';

/** Who a live voice session talks to (ADR 0304 D2). */
export type VoiceTarget =
  | { kind: 'agent'; rosterId: string }
  | { kind: 'generic' }
  | { kind: 'board'; boardId: string; handle: string };

export function rememberedVoiceTarget(conversationId: string | undefined): VoiceTarget | undefined {
  if (!conversationId) return undefined;
  try {
    const v = localStorage.getItem(REMEMBER_PREFIX + conversationId);
    if (v === null) return undefined; // never chosen
    if (v === '') return { kind: 'generic' }; // '' = the explicit generic choice
    if (v.startsWith(BOARD_MARK)) {
      const [, handle, boardId] = v.split('|');
      return handle && boardId ? { kind: 'board', boardId, handle } : undefined;
    }
    return { kind: 'agent', rosterId: v };
  } catch {
    return undefined;
  }
}

function rememberVoiceTarget(conversationId: string | undefined, target: VoiceTarget): void {
  if (!conversationId) return;
  const encoded = target.kind === 'generic' ? '' : target.kind === 'agent' ? target.rosterId : `${BOARD_MARK}${target.handle}|${target.boardId}`;
  try { localStorage.setItem(REMEMBER_PREFIX + conversationId, encoded); } catch { /* private mode */ }
}

export function VoiceAgentPicker({ conversationId, onPick, onClose }: {
  conversationId?: string | undefined;
  /** The chosen live-session target (agent / generic assistant / board). */
  onPick: (target: VoiceTarget) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  const [boards, setBoards] = useState<AdvisoryBoard[] | null>(null);
  useEffect(() => {
    let live = true;
    listRoster().then((r) => { if (live) setRoster(r.filter((e) => e.enabled !== false)); })
      .catch(() => { if (live) setRoster([]); });
    // Boards are optional company: a 404 (feature off) or error just hides the section.
    listBoards().then((b) => { if (live) setBoards(b); })
      .catch(() => { if (live) setBoards([]); });
    return () => { live = false; };
  }, []);

  const pick = (target: VoiceTarget) => {
    rememberVoiceTarget(conversationId, target);
    onPick(target);
  };

  return (
    <Modal label={t('voicePickerTitle')} onClose={onClose} showClose>
      <h2 className="u-mt-0 u-flex u-items-center u-gap-2"><MicIcon size={18} aria-hidden /> {t('voicePickerTitle')}</h2>
      <p className="muted u-fs-13">{t('voicePickerLede')}</p>
      {roster === null || boards === null ? (
        <Skeleton />
      ) : roster.length === 0 && boards.length === 0 ? (
        <StateCard icon={<BotIcon size={20} />} title={t('voicePickerNoneTitle')} body={t('voicePickerNoneBody')} />
      ) : (
        <>
          <ul className="u-list-none u-m-0 u-p-0" role="list">
            {roster.map((e) => (
              <li key={e.rosterId}>
                <Button
                  variant="quiet" fullWidth className="u-text-left u-py-1 u-flex u-items-center u-gap-2"
                  onClick={() => pick({ kind: 'agent', rosterId: e.rosterId })}
                >
                  <BotIcon size={16} aria-hidden />
                  <span className="u-flex-1 u-truncate">
                    <strong>{e.persona}</strong>
                    {e.label ? <span className="muted"> — {e.label}</span> : null}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
          {boards.length > 0 ? (
            <>
              <p className="muted u-fs-12 u-mb-0">{t('voicePickerBoardsLabel')}</p>
              <ul className="u-list-none u-m-0 u-p-0" role="list">
                {boards.map((b) => (
                  <li key={b.boardId}>
                    <Button
                      variant="quiet" fullWidth className="u-text-left u-py-1 u-flex u-items-center u-gap-2"
                      onClick={() => pick({ kind: 'board', boardId: b.boardId, handle: b.handle })}
                    >
                      <UsersIcon size={16} aria-hidden />
                      <span className="u-flex-1 u-truncate">
                        <strong>{b.name}</strong>
                        <span className="muted"> — @@{b.handle}</span>
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
      <div className="button-row u-mt-2">
        <Button variant="secondary" onClick={() => pick({ kind: 'generic' })}>
          {t('voicePickerGeneric')}
        </Button>
      </div>
    </Modal>
  );
}
