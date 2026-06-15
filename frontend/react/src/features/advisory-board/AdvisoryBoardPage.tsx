/**
 * Board of Advisors page (ADR 0040). Lists the workspace's advisory boards,
 * creates a new one (pick advisor roster agents + visibility + persona kind),
 * and convenes a board into a multi-speaker council chat. The backend is the
 * authority (toggle + RBAC + visibility + living-persona ack); this gates its
 * own render on useFeatureAccess and surfaces server messages.
 *
 * `ui/` cohesion: surface-card / chip / action-bar / Notice / StateCard / Field.
 *
 * @see docs/adr/0040-board-of-advisors.md
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { ScaleIcon, UserIcon, SparklesIcon, PlusIcon, TrashIcon, SendIcon } from '../../ui/icons/index.js';
import {
  listBoards, createBoard, deleteBoard, convene, listRoster, listOrgs,
  type AdvisoryBoard, type AdvisorySession, type CouncilTurn, type RosterMember, type OrgRef, type PersonaKind, type BoardVisibility,
} from './advisoryBoardClient.js';

const PERSONA_KINDS: { value: PersonaKind; label: string }[] = [
  { value: 'historical', label: 'Historical / public-domain figures' },
  { value: 'fictional', label: 'Fictional characters' },
  { value: 'original', label: 'Original personas' },
  { value: 'living', label: 'Living individuals (requires acknowledgement)' },
];

export function AdvisoryBoardPage(): JSX.Element {
  const access = useFeatureAccess('advisory-board');
  const [boards, setBoards] = useState<AdvisoryBoard[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [b, r, o] = await Promise.all([listBoards(), listRoster(), listOrgs()]);
      setBoards(b); setRoster(r); setOrgs(o);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (access.loading || !access.enabled) { setLoading(false); return; }
    void reload();
  }, [access.loading, access.enabled, reload]);

  if (access.loading || loading) return <StateCard title="Loading…" loading />;
  if (!access.enabled) {
    return (
      <StateCard
        icon={<ScaleIcon size={20} />}
        title="Board of Advisors is not enabled"
        body="Turn on the Board of Advisors feature for this workspace to assemble councils of advisor agents."
      />
    );
  }

  const selectedBoard = boards.find((b) => b.boardId === selected) ?? null;

  return (
    <div className="u-grid u-gap-4">
      <header className="action-bar u-items-center u-gap-2">
        <ScaleIcon size={22} />
        <div>
          <h1 className="u-fs-18 u-fw-600">Board of Advisors</h1>
          <p className="u-fs-13 muted">Assemble a council of advisor agents and convene them together in one chat.</p>
        </div>
      </header>

      {error ? <Notice variant="error">{error}</Notice> : null}

      {selectedBoard ? (
        <CouncilChat board={selectedBoard} onBack={() => setSelected(null)} />
      ) : (
        <div className="u-grid u-gap-4">
          <CreateBoardForm roster={roster} orgs={orgs} onCreated={async () => { await reload(); }} onError={setError} />
          <BoardList boards={boards} onOpen={setSelected} onDelete={async (id) => { await deleteBoard(id); await reload(); }} />
        </div>
      )}
    </div>
  );
}

function BoardList({ boards, onOpen, onDelete }: { boards: AdvisoryBoard[]; onOpen: (id: string) => void; onDelete: (id: string) => Promise<void> }): JSX.Element {
  if (boards.length === 0) {
    return <StateCard icon={<ScaleIcon size={20} />} title="No boards yet" body="Create your first board of advisors above." />;
  }
  return (
    <div className="u-grid u-gap-3">
      {boards.map((b) => (
        <div key={b.boardId} className="surface-card u-grid u-gap-2">
          <div className="action-bar u-items-center u-gap-2">
            <strong className="u-fs-15">{b.name}</strong>
            <span className="chip chip--muted">@@{b.handle}</span>
            <span className={`chip ${b.visibility === 'shared' ? 'chip--success' : 'chip--muted'}`}>{b.visibility}</span>
            <span className="chip chip--accent">{b.advisors.length} advisors</span>
            <div className="u-flex u-gap-2" style={{ marginLeft: 'auto' }}>
              <button type="button" className="primary" onClick={() => onOpen(b.boardId)}><SendIcon size={14} /> Convene</button>
              <button type="button" onClick={() => void onDelete(b.boardId)} aria-label={`Delete ${b.name}`}><TrashIcon size={14} /></button>
            </div>
          </div>
          {b.disclaimer ? <p className="u-fs-12 muted">{b.disclaimer}</p> : null}
        </div>
      ))}
    </div>
  );
}

function CreateBoardForm({ roster, orgs, onCreated, onError }: {
  roster: RosterMember[]; orgs: OrgRef[]; onCreated: () => Promise<void>; onError: (m: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<BoardVisibility>('private');
  const [personaKind, setPersonaKind] = useState<PersonaKind>('historical');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!orgId && orgs[0]) setOrgId(orgs[0].orgId); }, [orgs, orgId]);

  const toggle = (id: string): void => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const canSubmit = useMemo(() => name.trim().length > 0 && orgId && picked.length > 0 && (personaKind !== 'living' || ack), [name, orgId, picked, personaKind, ack]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await createBoard({ orgId, name: name.trim(), advisors: picked, visibility, personaKind, ...(personaKind === 'living' ? { livingPersonaAck: ack } : {}) });
      setName(''); setPicked([]); setAck(false);
      await onCreated();
    } catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  };

  if (roster.length === 0) {
    return <StateCard icon={<UserIcon size={20} />} title="No advisor agents yet" body="Add agents to your roster first — advisors are roster agents with their own persona and knowledge." />;
  }

  return (
    <form className="surface-card u-grid u-gap-3" onSubmit={(e) => void submit(e)}>
      <strong className="u-fs-15">New board</strong>
      <div className="action-bar u-gap-2 u-items-end u-wrap">
        <TextField label="Board name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Founders board" containerStyle={{ minWidth: '14rem' }} />
        <SelectField label="Organization" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
        <SelectField label="Visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as BoardVisibility)}>
          <option value="private">Private (only me)</option>
          <option value="shared">Shared (workspace)</option>
        </SelectField>
        <SelectField label="Persona kind" value={personaKind} onChange={(e) => setPersonaKind(e.target.value as PersonaKind)}>
          {PERSONA_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </SelectField>
      </div>

      <div className="u-grid u-gap-2">
        <span className="u-fs-13 u-fw-600">Advisors</span>
        <div className="u-flex u-gap-2 u-wrap">
          {roster.map((m) => (
            <button key={m.rosterId} type="button" className={`chip ${picked.includes(m.rosterId) ? 'chip--accent' : 'chip--muted'}`} onClick={() => toggle(m.rosterId)} aria-pressed={picked.includes(m.rosterId)}>
              <UserIcon size={12} /> {m.persona}
            </button>
          ))}
        </div>
      </div>

      {personaKind === 'living' ? (
        <label className="u-flex u-gap-2 u-items-start u-fs-13">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>I acknowledge these are simulated personas of living individuals for ideation only — not the real people, and not endorsed by them.</span>
        </label>
      ) : null}

      <div className="action-bar">
        <button type="submit" className="primary" disabled={!canSubmit || busy}><PlusIcon size={14} /> Create board</button>
      </div>
    </form>
  );
}

function CouncilChat({ board, onBack }: { board: AdvisoryBoard; onBack: () => void }): JSX.Element {
  const [session, setSession] = useState<AdvisorySession | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (prompt.trim().length === 0 || busy) return;
    setBusy(true); setError(null);
    try {
      const next = await convene(board.boardId, prompt.trim(), session?.sessionId);
      setSession(next); setPrompt('');
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="u-grid u-gap-3">
      <div className="action-bar u-items-center u-gap-2">
        <button type="button" onClick={onBack}>← Boards</button>
        <strong className="u-fs-15">{board.name}</strong>
        <span className="chip chip--muted">@@{board.handle}</span>
      </div>
      {board.disclaimer ? <Notice variant="warning">{board.disclaimer}</Notice> : null}
      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="surface-card u-grid u-gap-3" aria-live="polite">
        {!session ? (
          <p className="u-fs-13 muted">Ask the council a question to begin.</p>
        ) : (
          session.turns.map((t) => <CouncilTurnRow key={t.turnIndex} turn={t} />)
        )}
      </div>

      <form className="action-bar u-gap-2 u-items-end" onSubmit={(e) => void send(e)}>
        <TextField label="Ask the council" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="How should we approach this?" containerStyle={{ flex: 1 }} />
        <button type="submit" className="primary" disabled={busy || prompt.trim().length === 0}><SendIcon size={14} /> {busy ? 'Convening…' : 'Convene'}</button>
      </form>
    </div>
  );
}

function CouncilTurnRow({ turn }: { turn: CouncilTurn }): JSX.Element {
  const icon = turn.role === 'moderator' ? <SparklesIcon size={14} /> : turn.role === 'advisor' ? <UserIcon size={14} /> : null;
  const tone = turn.role === 'moderator' ? 'chip--accent' : turn.role === 'advisor' ? 'chip--success' : 'chip--muted';
  return (
    <div className="u-grid u-gap-1">
      <div className="u-flex u-gap-2 u-items-center">
        <span className={`chip ${tone}`}>{icon}{turn.speakerName}</span>
        {turn.grounded ? <span className="chip chip--muted">cited corpus</span> : null}
      </div>
      <p className="u-fs-14" style={{ whiteSpace: 'pre-wrap' }}>{turn.content}</p>
    </div>
  );
}
