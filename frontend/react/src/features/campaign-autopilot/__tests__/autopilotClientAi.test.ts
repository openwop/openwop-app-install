/** ADR 0712 / ADR 0961: explicit names only; blank retains the bodyless launch.
 * Sabotage-witnessed (w93): sending a body (or the JSON content-type) on a blank
 * launch; dropping the JSON content-type on a named launch; an unencoded
 * campaign id; a wrong base path; losing the top-level refusal reason. */
import { afterEach, expect, it, vi } from 'vitest';
import { config } from '../../../client/config.js';
import { AutopilotError, launchAutopilot } from '../autopilotClient.js';

const launchUrl = (encodedId: string): string => `${config.baseUrl}/host/openwop-app/campaign-autopilot/campaigns/${encodedId}/launch`;

afterEach(() => vi.unstubAllGlobals());
it('sends the selected name on the existing scoped action without changing the server payload contract', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ runId: 'run-local', campaignId: 'campaign/a', reused: false }), { status: 201 }));
  vi.stubGlobal('fetch', request);
  expect(await launchAutopilot('campaign/a', { credentialRef: 'google:testing' })).toEqual({ runId: 'run-local', campaignId: 'campaign/a', reused: false });
  const call = request.mock.calls[0];
  if (!call) throw new Error('Launch request absent');
  expect(String(call[0])).toBe(launchUrl('campaign%2Fa'));
  expect(call[1]?.method).toBe('POST');
  expect(new Headers(call[1]?.headers).get('content-type')).toBe('application/json');
  expect(call[1]?.body).toBe(JSON.stringify({ ai: { credentialRef: 'google:testing' } }));
});
it('blank preserves the prior bodyless launch and a reused result', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ runId: 'existing', campaignId: 'c1', reused: true }), { status: 200 }));
  vi.stubGlobal('fetch', request);
  expect((await launchAutopilot('c1')).reused).toBe(true);
  const call = request.mock.calls[0];
  if (!call) throw new Error('Launch request absent');
  expect(String(call[0])).toBe(launchUrl('c1'));
  expect(call[1]?.body).toBeUndefined();
  expect(new Headers(call[1]?.headers).has('content-type')).toBe(false);
  expect(call[1]?.method).toBe('POST');
});
it('preserves the scoped credential refusal reason so it is not shown as client edit denial', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'credential_forbidden', message: 'Unavailable', details: { reason: 'campaign_ai_key_forbidden' } }), { status: 403 })));
  const failure = await launchAutopilot('c1', { credentialRef: 'google:deleted' }).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(AutopilotError);
  expect(failure).toMatchObject({ status: 403, reason: 'campaign_ai_key_forbidden', message: 'Unavailable' });
});
