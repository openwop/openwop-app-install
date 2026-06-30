/**
 * Voice settings as a standalone surface (ADR 0144) — promotes the realtime-voice
 * provider/key card out of being buried in the Keys page into a first-class Access
 * Hub tab. Thin wrapper: fetches the stored BYOK refs the selector needs and
 * renders the existing `RealtimeVoiceSettings` card (single source of the logic).
 */
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { RealtimeVoiceSettings } from './RealtimeVoiceSettings.js';
import { useHub } from '../chrome/hubContext.js';
import { listStoredRefs } from './lib/byokClient.js';

export function VoiceSettingsPage(): JSX.Element {
  const { embedded } = useHub();
  const [refs, setRefs] = useState<readonly string[]>([]);
  useEffect(() => {
    void listStoredRefs()
      .then(setRefs)
      .catch(() => setRefs([]));
  }, []);
  // This surface only exists as an Access Hub tab (ADR 0144). A direct visit to
  // `/access/voice` lands here un-embedded — bounce it into the hub so the card
  // always renders inside the console chrome, never bare (review finding #2).
  if (!embedded) return <Navigate to="/access?tab=voice" replace />;
  return (
    <section className="u-grid u-gap-4">
      <RealtimeVoiceSettings storedRefs={refs} />
    </section>
  );
}
