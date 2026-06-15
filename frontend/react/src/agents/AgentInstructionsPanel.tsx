/**
 * Agent instructions panel (PRD §9 Instructions tab) — edit how the agent
 * behaves. Always editable: the human-friendly role description (roster
 * metadata). When the agent is backed by a user-authored agent (agentRef
 * `user.*`), the editable system prompt is shown too; saving replaces it.
 *
 * Security posture: the current system prompt is NOT read back (the
 * `GET /v1/agents` projection omits it — same credential-adjacency reasoning as
 * the fork flow's SR-1). The editor sets a new prompt; the PATCH response
 * confirms what was saved.
 *
 * For pack-installed agents the instructions are read-only with a
 * "Fork to customize" CTA.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { updateRosterEntry, type RosterEntry } from './rosterClient.js';
import { updateUserAgent } from '../client/agentsClient.js';
import { Notice } from '../ui/Notice.js';
import { MarkdownEditor } from '../ui/MarkdownEditor.js';
import { Markdown } from '../ui/Markdown.js';
import { StructuredPromptEditor } from './StructuredPromptEditor.js';

export function AgentInstructionsPanel({ entry, onChanged }: { entry: RosterEntry; onChanged: () => void }): JSX.Element {
  const navigate = useNavigate();
  const agentId = entry.agentRef.agentId;
  const isUserAuthored = agentId.startsWith('user.');
  // A `host:*` agentRef is a synthetic/built-in example template — it does NOT
  // resolve to a forkable manifest agent (GET /v1/agents 404s), so a "Fork"
  // CTA would dead-end on an empty form. Only genuinely-installed pack agents
  // are forkable.
  const isForkable = !isUserAuthored && !agentId.startsWith('host:');

  const [description, setDescription] = useState(entry.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [savedPrompt, setSavedPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSaveDescription = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await updateRosterEntry(entry.rosterId, { description });
      try { window.localStorage.removeItem(`owp.draft.desc.${entry.rosterId}`); } catch { /* ignore */ }
      setNotice('Saved.');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onSavePrompt = async () => {
    if (!systemPrompt.trim()) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateUserAgent(agentId, { systemPrompt });
      try { window.localStorage.removeItem(`owp.draft.prompt.${agentId}`); } catch { /* ignore */ }
      setSavedPrompt(updated.systemPrompt);
      setSystemPrompt('');
      setNotice('Instructions updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="agentinstr-root">
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      <div className="u-block u-fw-600 u-mb-1">What this agent does</div>
      <p className="muted u-fs-13 u-mt-0">
        A short description of {entry.persona}'s role — shown on the dashboard and overview.
      </p>
      <MarkdownEditor
        value={description}
        onChange={setDescription}
        rows={3}
        maxLength={600}
        autosaveKey={`owp.draft.desc.${entry.rosterId}`}
        placeholder={`e.g. **${entry.persona}** routes leads and follows up on opportunities.`}
        ariaLabel={`${entry.persona}'s role description`}
      />
      <div className="agentinstr-save-row">
        <button type="button" className="primary" onClick={() => void onSaveDescription()} disabled={saving}>Save</button>
      </div>

      <div className="u-block u-fw-600 u-mb-1">Instructions</div>
      <p className="muted u-fs-13 u-mt-0">
        These instructions shape how {entry.persona} behaves when running workflows or replying in chat.
      </p>

      {isUserAuthored ? (
        <>
          <p className="muted u-fs-12 u-mt-0">
            For security, the current instructions aren't shown here — saving replaces them.
          </p>
          <StructuredPromptEditor
            value={systemPrompt}
            onChange={setSystemPrompt}
            autosaveKey={`owp.draft.prompt.${agentId}`}
          />
          <div className="u-mt-1-5">
            <button type="button" className="primary" onClick={() => void onSavePrompt()} disabled={saving || !systemPrompt.trim()}>Save instructions</button>
          </div>
          {savedPrompt ? (
            <div className="agentinstr-saved">
              <div className="muted u-fs-12">Saved instructions:</div>
              <div className="surface-card agentinstr-saved-card">
                <Markdown>{savedPrompt}</Markdown>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="agentinstr-readonly">
          {isForkable ? (
            <>
              <p className="u-mt-0 u-fs-14">
                {entry.persona} runs an installed agent template (<code>{agentId}</code>). Its instructions are read-only here.
              </p>
              <button type="button" className="secondary" onClick={() => navigate(`/agents/fork?fork=${encodeURIComponent(agentId)}`)}>
                Fork to customize
              </button>
            </>
          ) : (
            <>
              <p className="u-mt-0 u-fs-14">
                {entry.persona} is a built-in example agent — its underlying instructions aren't editable here. Create your
                own agent to write custom instructions from scratch.
              </p>
              <button type="button" className="secondary" onClick={() => navigate('/agents/new')}>
                Create your own agent
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
