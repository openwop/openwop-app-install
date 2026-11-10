/**
 * ADR 1042 D3/D7 — one connection's channel settings: the answering agent, the
 * bot handle groups must mention, an optional model, the sender binding, and
 * its senders.
 *
 * `PUT …/channel` replaces the whole row, so the form always sends every field
 * it shows; an empty field is cleared, never silently kept.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { SelectField, TextField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import type { AgentEntry } from '../../client/agentsClient.js';
import { SendersSection } from './SendersSection.js';
import {
  CONVERSATIONAL_PROVIDERS, deleteBinding, getBinding, putBinding, putChannelSettings, refusalMessage,
  type ChannelConnection, type ChannelSettings, type InboundConfig, type SenderBinding,
} from './channelIngressClient.js';

function SettingsForm({ connection, settings, agents, agentsFailed, onSaved }: {
  connection: ChannelConnection;
  settings: ChannelSettings | null;
  agents: readonly AgentEntry[] | null;
  agentsFailed: boolean;
  onSaved: (s: ChannelSettings) => void;
}): JSX.Element {
  const { t } = useTranslation('channel-ingress');
  const id = useId();
  const [agentId, setAgentId] = useState(settings?.agentId ?? '');
  const [botHandle, setBotHandle] = useState(settings?.botHandle ?? '');
  const [provider, setProvider] = useState(settings?.provider ?? '');
  const [model, setModel] = useState(settings?.model ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const next = {
      ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
      ...(botHandle.trim() ? { botHandle: botHandle.trim() } : {}),
      ...(provider.trim() ? { provider: provider.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    };
    try {
      onSaved(await putChannelSettings(connection.connectionId, next));
      toast.success(t('settingsSaved'));
    } catch (err) {
      setError(refusalMessage(err) ?? t('settingsSaveFailed'));
    } finally {
      setBusy(false);
    }
  };

  // The current agent stays selectable even if the list no longer has it.
  const known = agents?.some((a) => a.agentId === agentId) ?? false;
  return (
    <form className="u-grid u-gap-3" aria-labelledby={`${id}-title`} aria-busy={busy || undefined} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h4 id={`${id}-title`} className="u-fs-14 u-m-0">{t('settingsTitle')}</h4>
      {agentsFailed || agents === null ? (
        <>
          {agentsFailed ? <Notice variant="warning" announce={t('agentsLoadError')}>{t('agentsLoadError')}</Notice> : null}
          <TextField label={t('agentIdLabel')} help={t('agentHelp')} value={agentId} disabled={agents === null && !agentsFailed} onChange={(e) => setAgentId(e.target.value)} />
        </>
      ) : (
        <SelectField label={t('agentLabel')} help={t('agentHelp')} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">{t('defaultAssistant')}</option>
          {!known && agentId ? <option value={agentId}>{agentId}</option> : null}
          {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.label || a.agentId}</option>)}
        </SelectField>
      )}
      <TextField label={t('botHandleLabel')} help={t('botHandleHelp')} value={botHandle} maxLength={65} autoComplete="off" onChange={(e) => setBotHandle(e.target.value)} />
      <div className="profile-grid-220">
        <TextField label={t('modelProviderLabel')} value={provider} autoComplete="off" onChange={(e) => setProvider(e.target.value)} />
        <TextField label={t('modelLabel')} help={t('modelHelp')} value={model} autoComplete="off" onChange={(e) => setModel(e.target.value)} />
      </div>
      {error ? <p role="alert" className="u-m-0 u-text-danger">{error}</p> : null}
      <div className="action-bar">
        <Button variant="primary" type="submit" disabled={busy}>{t('saveSettings')}</Button>
      </div>
    </form>
  );
}

function BindingForm({ connectionId, inboundProvider }: { connectionId: string; inboundProvider: string }): JSX.Element {
  const { t } = useTranslation('channel-ingress');
  const id = useId();
  const [binding, setBinding] = useState<SenderBinding | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setFailed(false);
    void getBinding(connectionId).then((b) => { setBinding(b); setValue(b?.channelId ?? ''); }).catch(() => setFailed(true));
  }, [connectionId]);
  useEffect(load, [load]);

  const help = inboundProvider === 'whatsapp-twilio' || inboundProvider === 'whatsapp-cloud' ? t(`bindingHelp_${inboundProvider}`) : t('bindingHelp_chat');
  const run = async (op: () => Promise<SenderBinding | null>, ok: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { const b = await op(); setBinding(b); setValue(b?.channelId ?? ''); toast.success(ok); } catch (err) { setError(refusalMessage(err) ?? t('bindingFailed')); } finally { setBusy(false); }
  };
  if (failed) {
    return (
      <div className="u-grid u-gap-2">
        <Notice variant="error" announce={t('bindingLoadError')}>{t('bindingLoadError')}</Notice>
        <div><Button variant="quiet" size="sm" onClick={load}>{t('retry')}</Button></div>
      </div>
    );
  }
  return (
    <form className="u-grid u-gap-3" aria-labelledby={`${id}-title`} aria-busy={busy || binding === undefined || undefined}
      onSubmit={(e) => { e.preventDefault(); if (value.trim()) void run(() => putBinding(connectionId, inboundProvider, value.trim()), t('bindingSaved')); }}>
      <div>
        <h4 id={`${id}-title`} className="u-fs-14 u-m-0">{t('bindingTitle')}</h4>
        <p className="muted u-fs-13 u-m-0">{t('bindingHelp')}</p>
      </div>
      <TextField label={t('bindingLabel')} help={help} value={value} placeholder={t('bindingNone')} autoComplete="off" disabled={binding === undefined} onChange={(e) => setValue(e.target.value)} />
      {error ? <p role="alert" className="u-m-0 u-text-danger">{error}</p> : null}
      <div className="action-bar">
        {binding ? (
          <Button variant="quiet" type="button" disabled={busy} onClick={() => void run(async () => { await deleteBinding(connectionId); return null; }, t('bindingCleared'))}>{t('clearBinding')}</Button>
        ) : null}
        <Button variant="secondary" type="submit" disabled={busy || !value.trim() || value.trim() === binding?.channelId}>{t('saveBinding')}</Button>
      </div>
    </form>
  );
}

export function ConnectionChannelPanel({ connection, inbound, settings, agents, agentsFailed, onSettingsSaved, onClose }: {
  connection: ChannelConnection;
  inbound: InboundConfig | null;
  settings: ChannelSettings | null;
  agents: readonly AgentEntry[] | null;
  agentsFailed: boolean;
  onSettingsSaved: (s: ChannelSettings) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('channel-ingress');
  const id = useId();
  const inboundProvider = inbound?.provider ?? connection.provider;
  const bindable = CONVERSATIONAL_PROVIDERS.has(inboundProvider);
  return (
    <section className="surface-card u-grid u-gap-4" aria-labelledby={`${id}-title`}>
      <div className="u-flex u-items-center u-justify-between u-gap-2">
        <h3 id={`${id}-title`} className="u-fs-16 u-m-0">{t('panelTitle', { name: connection.displayName })}</h3>
        <Button variant="quiet" size="sm" onClick={onClose}>{t('close')}</Button>
      </div>
      {inbound?.mode !== 'conversation' ? (
        <Notice variant="info">{inbound ? t('modeWorkflowHint') : t('modeNoneHint')}</Notice>
      ) : null}
      <SettingsForm key={connection.connectionId} connection={connection} settings={settings} agents={agents} agentsFailed={agentsFailed} onSaved={onSettingsSaved} />
      {bindable ? <BindingForm key={`b-${connection.connectionId}`} connectionId={connection.connectionId} inboundProvider={inboundProvider} /> : null}
      <SendersSection key={`s-${connection.connectionId}`} connectionId={connection.connectionId} botHandle={settings?.botHandle} />
    </section>
  );
}
