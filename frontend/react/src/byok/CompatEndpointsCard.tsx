/**
 * Self-hosted / OpenAI-compatible endpoints (RFC 0108 + ADR 0121) — connect form
 * on the BYOK Keys page. An operator points the host at Ollama / LM Studio / vLLM /
 * any OpenAI-compatible base URL (optional key), declares the endpoint's
 * capabilities (the host can't probe a black box), and dispatch routes through the
 * shared compat path.
 *
 * The whole surface 404s when `OPENWOP_COMPAT_PROVIDER_ENABLED` is off — the card
 * renders nothing then (operator opt-in not granted). §D: the base URL is shown only
 * to the owning org here; the key value never returns to the FE.
 *
 * @see docs/adr/0121-local-model-provider-support.md
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextField, CheckboxField, SelectField } from '../ui/Field.js';
import { Notice } from '../ui/index.js';
import { confirm } from '../ui/confirm.js';
import { listOrgs, type Org } from '../client/promptLibraryClient.js';
import {
  listCompatEndpoints, createCompatEndpoint, deleteCompatEndpoint,
  type CompatEndpointView,
} from './lib/compatClient.js';

export function CompatEndpointsCard(): JSX.Element | null {
  const { t } = useTranslation('byok');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgId, setOrgId] = useState('');
  const [endpoints, setEndpoints] = useState<CompatEndpointView[]>([]);
  const [busy, setBusy] = useState(false);
  const [writeForbidden, setWriteForbidden] = useState(false);
  const [notice, setNotice] = useState<{ variant: 'success' | 'error'; msg: string } | null>(null);

  // create-form state
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [vision, setVision] = useState(false);
  const [tools, setTools] = useState(false);
  const [longContext, setLongContext] = useState(false);
  const [models, setModels] = useState('');

  useEffect(() => {
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, []);

  useEffect(() => {
    if (!orgId) return;
    let active = true;
    setWriteForbidden(false); // a different org may grant write
    void listCompatEndpoints(orgId)
      .then((list) => { if (!active) return; if (list === null) { setAvailable(false); } else { setAvailable(true); setEndpoints(list); } })
      .catch(() => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, [orgId]);

  if (available === null || available === false) return null;

  const canCreate = label.trim().length > 0 && baseUrl.trim().length > 0 && !busy;

  async function create(): Promise<void> {
    setBusy(true); setNotice(null);
    try {
      const modelList = models.split(',').map((m) => m.trim()).filter(Boolean);
      const created = await createCompatEndpoint({
        orgId, label: label.trim(), baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        capabilities: { vision, tools, longContext },
        ...(modelList.length ? { models: modelList } : {}),
      });
      setEndpoints((prev) => [...prev, created]);
      setLabel(''); setBaseUrl(''); setApiKey(''); setVision(false); setTools(false); setLongContext(false); setModels('');
      setNotice({ variant: 'success', msg: t('compatSaved', { defaultValue: 'Endpoint added' }) });
    } catch (err) {
      // Read-but-not-write member: the org list (workspace:read) succeeded so the card
      // showed, but create needs workspace:write. Degrade gracefully — disable the form
      // with a clear read-only notice instead of letting them keep failing.
      if ((err as { status?: number }).status === 403) {
        setWriteForbidden(true);
        setNotice({ variant: 'error', msg: t('compatReadOnly', { defaultValue: 'You have read-only access to this organization’s endpoints.' }) });
      } else {
        setNotice({ variant: 'error', msg: err instanceof Error ? err.message : t('compatError', { defaultValue: 'Could not save the endpoint.' }) });
      }
    } finally { setBusy(false); }
  }

  async function remove(ep: CompatEndpointView): Promise<void> {
    if (!(await confirm({ title: t('compatDeleteConfirm', { defaultValue: 'Remove this endpoint?' }), danger: true }))) return;
    try {
      await deleteCompatEndpoint(ep.id);
      setEndpoints((prev) => prev.filter((e) => e.id !== ep.id));
    } catch (err) {
      setNotice({ variant: 'error', msg: err instanceof Error ? err.message : t('compatError', { defaultValue: 'Could not save the endpoint.' }) });
    }
  }

  return (
    <section className="surface-card u-mt-4">
      <h2 className="u-fs-16 u-m-0 u-mb-1">{t('compatTitle', { defaultValue: 'Self-hosted / OpenAI-compatible endpoints' })}</h2>
      <p className="field-help u-mb-2">{t('compatIntro', { defaultValue: 'Connect Ollama, LM Studio, vLLM, or any OpenAI-compatible API by base URL (with an optional key). Declare what the endpoint supports — the host can’t probe a private endpoint, so capabilities are taken from what you set here.' })}</p>

      {orgs.length > 1 && (
        <div className="u-mb-2">
          <SelectField label={t('compatOrg', { defaultValue: 'Organization' })} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </SelectField>
        </div>
      )}

      {endpoints.length > 0 && (
        <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-2 u-mb-3">
          {endpoints.map((ep) => (
            <li key={ep.id} className="surface-inset u-pad-2 u-flex u-items-center u-justify-between u-gap-2">
              <div className="u-flex u-flex-col u-gap-1">
                <span className="u-fs-12 u-fw-600">{ep.label}</span>
                <code className="u-fs-11 muted" style={{ overflowWrap: 'anywhere' }}>{ep.baseUrl}</code>
                <div className="u-flex u-flex-wrap u-gap-1 u-fs-11">
                  {ep.hasKey && <span className="chip chip--muted">{t('compatHasKey', { defaultValue: 'key set' })}</span>}
                  {ep.capabilities.vision && <span className="chip chip--accent">{t('compatVision', { defaultValue: 'vision' })}</span>}
                  {ep.capabilities.tools && <span className="chip chip--accent">{t('compatTools', { defaultValue: 'tools' })}</span>}
                  {ep.capabilities.longContext && <span className="chip chip--accent">{t('compatLongContext', { defaultValue: 'long context' })}</span>}
                </div>
                {ep.models && ep.models.length > 0 && (
                  <span className="muted u-fs-11">{t('compatModelsList', { defaultValue: 'Models: {{list}}', list: ep.models.join(', ') })}</span>
                )}
              </div>
              <button type="button" className="btn-ghost u-fs-11" onClick={() => void remove(ep)} aria-label={t('compatDelete', { defaultValue: 'Remove endpoint' })}>{t('compatDelete', { defaultValue: 'Remove' })}</button>
            </li>
          ))}
        </ul>
      )}

      {writeForbidden ? null : (
        <>
          <TextField label={t('compatLabel', { defaultValue: 'Label' })} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Local Ollama" />
          <TextField label={t('compatBaseUrl', { defaultValue: 'Base URL' })} help={t('compatBaseUrlHelp', { defaultValue: 'The OpenAI-compatible base, e.g. http://localhost:11434/v1 (https required unless a local endpoint is explicitly allowed).' })} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://vllm.internal/v1" />
          <TextField label={t('compatApiKey', { defaultValue: 'API key (optional)' })} help={t('compatApiKeyHelp', { defaultValue: 'Left empty for keyless local endpoints (e.g. Ollama). The value stays on the host.' })} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
          <fieldset className="u-border-0 u-p-0 u-m-0 u-mt-1">
            <legend className="u-fs-12 u-fw-600">{t('compatCapsLegend', { defaultValue: 'Declared capabilities' })}</legend>
            <div className="u-flex u-flex-wrap u-gap-3 u-mt-1">
              <CheckboxField label={t('compatVision', { defaultValue: 'vision' })} checked={vision} onChange={(e) => setVision(e.target.checked)} />
              <CheckboxField label={t('compatTools', { defaultValue: 'tools' })} checked={tools} onChange={(e) => setTools(e.target.checked)} />
              <CheckboxField label={t('compatLongContext', { defaultValue: 'long context' })} checked={longContext} onChange={(e) => setLongContext(e.target.checked)} />
            </div>
          </fieldset>
          <TextField label={t('compatModels', { defaultValue: 'Model ids (optional, comma-separated)' })} value={models} onChange={(e) => setModels(e.target.value)} placeholder="llama3.1, qwen2.5-coder" />

          <div className="u-flex u-gap-2 u-mt-2">
            <button type="button" className="btn-primary" disabled={!canCreate} onClick={() => void create()}>{t('compatAdd', { defaultValue: 'Add endpoint' })}</button>
          </div>
        </>
      )}
      {notice ? <div className="u-mt-2"><Notice variant={notice.variant}>{notice.msg}</Notice></div> : null}
    </section>
  );
}
