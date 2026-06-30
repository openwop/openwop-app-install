/**
 * Agent voice panel (ADR 0138 P3) — sets the agent's SPOKEN voice for voice mode.
 *
 * The voice lives in the existing agent-config seam (`agentProfile.configParameters.voice
 * = { provider, voiceId }`, ADR 0031) — NOT a new per-agent voice store. When a voice
 * session is scoped to this agent, its streaming-TTS reply uses this voice; absent one,
 * the host default. ElevenLabs and the other providers route through the shared
 * `callSpeechSynthesizer` adapter (BYOK where required).
 *
 * PUT replaces the whole profile, so save carries every loaded field through and merges
 * only `configParameters.voice` (the AgentGuardrailsPanel discipline — never wipe siblings).
 *
 * NON-NORMATIVE host-local product config under `/v1/host/openwop-app/*`.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAgentProfile, putAgentProfile, type AgentProfile, type AgentProfileInput } from './rosterClient.js';
import { listStoredRefs } from '../byok/lib/byokClient.js';
import { Notice } from '../ui/Notice.js';
import { SelectField, TextField } from '../ui/Field.js';
import { MicIcon } from '../ui/icons/index.js';

/** Providers whose key is BYOK (no managed host key) — they need a credentialRef. */
const BYOK_PROVIDERS = new Set(['elevenlabs', 'openai', 'google']);

/** TTS providers the voice reply can use (matches the host `callSpeechSynthesizer` set).
 *  Brand labels are proper nouns (not translated); the default label + hints are i18n keys. */
const VOICE_PROVIDERS: Array<{ id: string; label?: string; hintKey: string }> = [
  { id: '', hintKey: 'voiceHintDefault' },
  { id: 'elevenlabs', label: 'ElevenLabs', hintKey: 'voiceHintElevenlabs' },
  { id: 'openai', label: 'OpenAI', hintKey: 'voiceHintOpenai' },
  { id: 'google', label: 'Google', hintKey: 'voiceHintGoogle' },
  { id: 'minimax', label: 'MiniMax', hintKey: 'voiceHintMinimax' },
];

interface VoiceConfig { provider?: string; voiceId?: string; credentialRef?: string }

/** Build a full PUT body from the loaded profile, merging only the voice. */
function buildInput(profile: AgentProfile | null, voice: VoiceConfig | undefined): AgentProfileInput {
  const configParameters = { ...(profile?.configParameters ?? {}) } as Record<string, unknown>;
  if (voice && (voice.provider || voice.voiceId)) configParameters.voice = voice;
  else delete configParameters.voice;
  return {
    roleKey: profile?.roleKey ?? 'custom',
    ...(profile?.department ? { department: profile.department } : {}),
    ...(Object.keys(configParameters).length ? { configParameters } : {}),
    ...(profile?.permissions ? { permissions: profile.permissions } : {}),
    ...(profile?.hitl?.length ? { hitl: profile.hitl } : {}),
    ...(profile?.escalation ? { escalation: profile.escalation } : {}),
    ...(profile?.requiredConnections?.length ? { requiredConnections: profile.requiredConnections } : {}),
    ...(profile?.metrics?.length ? { metrics: profile.metrics } : {}),
    // W4 (architect #4): the full-replace PUT preserves only capabilities/knowledge/twin
    // server-side, so carry these through too — a VOICE edit must not wipe governance fields.
    ...(profile?.channels ? { channels: profile.channels } : {}),
    ...(profile?.adminControls?.length ? { adminControls: profile.adminControls } : {}),
    ...(profile?.riskCompliance?.length ? { riskCompliance: profile.riskCompliance } : {}),
    autonomy: {
      specLevel: profile?.autonomy.specLevel ?? 'draft-only',
      ...(profile?.autonomy.withinPolicyActions?.length ? { withinPolicyActions: profile.autonomy.withinPolicyActions } : {}),
    },
  };
}

export function AgentVoicePanel({ rosterId }: { rosterId: string }): JSX.Element {
  const { t } = useTranslation('agents');
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [provider, setProvider] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [storedRefs, setStoredRefs] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [p, refs] = await Promise.all([getAgentProfile(rosterId), listStoredRefs().catch(() => [])]);
        if (!live) return;
        setProfile(p);
        setStoredRefs(refs);
        const v = (p?.configParameters as { voice?: VoiceConfig } | undefined)?.voice;
        setProvider(v?.provider ?? '');
        setVoiceId(v?.voiceId ?? '');
        setCredentialRef(v?.credentialRef ?? '');
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { live = false; };
  }, [rosterId]);

  const save = async (): Promise<void> => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const needsCred = BYOK_PROVIDERS.has(provider);
      const voice: VoiceConfig = {
        ...(provider ? { provider } : {}),
        ...(voiceId.trim() ? { voiceId: voiceId.trim() } : {}),
        ...(needsCred && credentialRef ? { credentialRef } : {}),
      };
      const saved = await putAgentProfile(rosterId, buildInput(profile, voice));
      setProfile(saved);
      setNotice(t('voiceSaved'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const hintKey = VOICE_PROVIDERS.find((p) => p.id === provider)?.hintKey;

  return (
    <section className="surface-card u-flex u-flex-col u-gap-3" aria-labelledby="agent-voice-h">
      <h3 id="agent-voice-h" className="u-fs-14 u-fw-600 u-m-0 u-flex u-items-center u-gap-2">
        <MicIcon size={15} aria-hidden /> {t('voiceTitle')}
      </h3>
      <p className="muted u-fs-13 u-m-0">{t('voiceDesc')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}
      <div className="u-flex u-gap-3 u-flex-wrap u-items-end">
        <SelectField label={t('voiceProvider')} value={provider} onChange={(e) => setProvider(e.target.value)} className="u-flex-1">
          {VOICE_PROVIDERS.map((p) => <option key={p.id || 'default'} value={p.id}>{p.label ?? t('voiceProviderDefault')}</option>)}
        </SelectField>
        <TextField
          label={t('voiceVoiceId')}
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          placeholder={provider === 'elevenlabs' ? 'e.g. 21m00Tcm4TlvDq8ikWAM' : t('voiceIdPlaceholder')}
          disabled={!provider}
          className="u-flex-2"
        />
      </div>
      {BYOK_PROVIDERS.has(provider) ? (
        <div className="u-flex u-flex-col u-gap-1">
          <SelectField label={t('voiceKey')} value={credentialRef} onChange={(e) => setCredentialRef(e.target.value)}>
            <option value="">{t('voiceKeySelect')}</option>
            {storedRefs.map((ref) => <option key={ref} value={ref}>{ref}</option>)}
          </SelectField>
          {storedRefs.length === 0 ? (
            <p className="muted u-fs-12 u-m-0">{t('voiceNoKeys')}</p>
          ) : credentialRef ? null : (
            <p className="muted u-fs-12 u-m-0">{t('voiceNeedsKey')}</p>
          )}
        </div>
      ) : null}
      {hintKey ? <p className="muted u-fs-12 u-m-0">{t(hintKey)}</p> : null}
      <div className="action-bar">
        <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void save()}>
          {busy ? t('voiceSaving') : t('voiceSave')}
        </button>
      </div>
    </section>
  );
}
