/**
 * ADR 0910 D8 — the Challenge Factory's own AI key, set where the operator works.
 *
 * The Factory picks `kicktodo-factory:<provider>` by name, so chat never borrows it
 * and it never borrows chat's key. The Keys page cannot write that ref: its
 * add-key form always builds `<provider>:<label>`, and a `google:kicktodo-factory`
 * ref would be picked up by the chat ladder's prefix rung, which defeats D8. This
 * card writes the dedicated ref through the same secrets route, so the value goes
 * from the operator's browser straight into the vault, and the page only ever
 * sees which refs exist.
 *
 * Shown to a listed superadmin while the session is in `host-kicktodo`: the vault
 * write lands in the ACTIVE workspace, so anywhere else the card says to switch
 * in first. The host still decides (operator access grants the AI keys), so the
 * card reads this person's activation and, with none live, says so and links to
 * People & access BEFORE a key is pasted; a 403 keeps its own copy as the backstop
 * (an activation that lapses mid-form, or a read that failed).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { SelectField, TextField } from '../../ui/Field.js';
import { useEffectiveAccessState } from '../../client/useEffectiveAccess.js';
import { listMyWorkspaces } from '../../client/workspaceClient.js';
import { listStoredRefs, storeKey } from '../../byok/lib/byokClient.js';
import { listOperatorActivations } from '../../client/operatorAccessClient.js';
import { useBackendSession } from '../../auth/backendSession.js';
import { ApiError } from '../../client/requestJson.js';
import { OPERATOR_WORKSPACE } from './OperatorAccessPanel.js';

const FACTORY_PREFIX = 'kicktodo-factory:';
/** Provider ids as the host names them; labels are product names, not copy. */
const PROVIDERS = [
  { id: 'google', label: 'Google (Gemini)' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
] as const;

/** `operatorLive` is null when the activation read failed: unknown, so the form
 *  stays usable and a 403 explains a refusal. */
type Load = { inWorkspace: false } | { inWorkspace: true; saved: readonly string[]; operatorLive: boolean | null };

export function FactoryKeyCard(): JSX.Element | null {
  const { t } = useTranslation('kicktodo-admin');
  const { access, resolved } = useEffectiveAccessState();
  const eligible = resolved && access.superadmin === true;
  const callerSubject = useBackendSession().user?.userId;

  const [load, setLoad] = useState<Load | null | undefined>(undefined);
  const [provider, setProvider] = useState<string>(PROVIDERS[0].id);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<'forbidden' | 'failed' | null>(null);
  const [savedNow, setSavedNow] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoad(undefined);
    try {
      const { active } = await listMyWorkspaces();
      if (active !== OPERATOR_WORKSPACE) { setLoad({ inWorkspace: false }); return; }
      const [refs, activations] = await Promise.all([
        listStoredRefs(),
        listOperatorActivations(OPERATOR_WORKSPACE).catch(() => null),
      ]);
      const now = Date.now();
      setLoad({
        inWorkspace: true,
        saved: refs.filter((r) => r.startsWith(FACTORY_PREFIX)).map((r) => r.slice(FACTORY_PREFIX.length)),
        operatorLive: activations === null
          ? null
          : activations.some((a) => a.subject === callerSubject && !a.revokedAt && Date.parse(a.expiresAt) > now),
      });
    } catch {
      setLoad(null);
    }
  }, [callerSubject]);
  useEffect(() => { if (eligible) void reload(); }, [eligible, reload]);

  if (!eligible) return null;

  const save = async (): Promise<void> => {
    setProblem(null);
    setSavedNow(null);
    setSaving(true);
    try {
      await storeKey(`${FACTORY_PREFIX}${provider}`, value.trim());
      setValue('');
      setSavedNow(provider);
      await reload();
    } catch (err) {
      setProblem(err instanceof ApiError && err.status === 403 ? 'forbidden' : 'failed');
    } finally {
      setSaving(false);
    }
  };

  const labelOf = (id: string): string => PROVIDERS.find((p) => p.id === id)?.label ?? id;

  return (
    <section className="surface-card" aria-label={t('factoryKeyHeading')}>
      <h2 className="kt-eyebrow">{t('factoryKeyHeading')}</h2>
      <p className="muted u-fs-13">{t('factoryKeyDescription')}</p>

      {load === undefined ? <p>{t('factoryKeyLoading')}</p> : null}
      {load === null ? (
        <Notice variant="error" announce={t('factoryKeyLoadError')}>
          {t('factoryKeyLoadError')} <Button variant="secondary" size="sm" onClick={() => void reload()}>{t('retry')}</Button>
        </Notice>
      ) : null}
      {load && !load.inWorkspace ? <Notice variant="info">{t('factoryKeySwitchFirst')}</Notice> : null}

      {load && load.inWorkspace ? (
        <>
          <div className="action-bar">
            {load.saved.length > 0
              ? load.saved.map((id) => <span key={id} className="chip chip--success">{t('factoryKeySaved', { provider: labelOf(id) })}</span>)
              : <span className="chip chip--muted">{t('factoryKeyNone')}</span>}
          </div>
          {load.saved.length === 0 ? <p className="muted u-fs-13">{t('factoryKeyFallback')}</p> : null}
          {load.operatorLive === false ? (
            <Notice variant="info">
              {t('factoryKeyNeedsOperator')} <Link className="inline-link" to="/admin/kicktodo/people">{t('factoryKeyActivateLink')}</Link>
            </Notice>
          ) : null}
          {savedNow ? <Notice variant="success" announce={t('factoryKeyStored', { provider: labelOf(savedNow) })}>{t('factoryKeyStored', { provider: labelOf(savedNow) })}</Notice> : null}
          {problem ? <Notice variant="error" announce={t(`factoryKeyProblem_${problem}`)}>{t(`factoryKeyProblem_${problem}`)}</Notice> : null}
          {/* Stacked, not .surface-form: that toolbar bottom-aligns its items, and
              the key field's help text pushed it out of line with the select. */}
          <div className="u-grid u-gap-3">
            <SelectField label={t('factoryKeyProvider')} value={provider} onChange={(e) => setProvider(e.target.value)} disabled={load.operatorLive === false}>
              {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </SelectField>
            <TextField
              label={t('factoryKeyValue')}
              help={t('factoryKeyValueHelp')}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              disabled={load.operatorLive === false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <div className="action-bar">
              <Button onClick={() => void save()} disabled={load.operatorLive === false || value.trim().length === 0} loading={saving}>
                {load.saved.includes(provider) ? t('factoryKeyReplace') : t('factoryKeySave')}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
