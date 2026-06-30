/**
 * ADR 0168 Part A — headless capability profile.
 *
 * `OPENWOP_PROFILE=full` (default) | `headless`. A single host-config knob that
 * makes the `/.well-known/openwop` advertisement reflect the deployment's actual
 * CLIENT-PRESENTATION surfaces, single-sourced so advertise and serve cannot
 * drift. In `headless`, the three browser-render surfaces are withheld from BOTH
 * the discovery document AND their route/seam mounts (don't serve what you don't
 * advertise — honest + smaller attack surface). Everything else (runs, workflows,
 * agents, the RFC 0005 conversation primitive, dispatch, storage, auth) is
 * unaffected: the backend is headless-by-construction (zero browser-global
 * runtime deps; the SPA is purely a view over the API).
 *
 * Per-capability override: `OPENWOP_PRESENTATION_<CAP>=on|off` wins over the
 * profile default (e.g. headless-but-with-uiPlugins). Profile sets the defaults.
 *
 * Withholding a SUBSET of optional capabilities is always conformant
 * (`capabilities.md` — a host MAY omit any optional capability), so the profile
 * never makes a new wire claim; it only makes the advert honest for a deployment
 * with no rendering client.
 *
 * @see docs/adr/0168-headless-profile-and-first-party-cli.md
 */

export type HostProfile = 'full' | 'headless';

/** The three client-presentation surfaces a headless deployment withholds. */
export type PresentationCapability = 'uiPlugins' | 'realtimeVoice' | 'chatWidget';

const ENV_SUFFIX: Record<PresentationCapability, string> = {
  uiPlugins: 'UIPLUGINS',
  realtimeVoice: 'REALTIMEVOICE',
  chatWidget: 'CHATWIDGET',
};

/** The active host profile (default `full` — exactly today's behavior). */
export function hostProfile(): HostProfile {
  return process.env.OPENWOP_PROFILE === 'headless' ? 'headless' : 'full';
}

/**
 * Whether a client-presentation surface is presented by this deployment.
 * Default by profile (`full` ⇒ all on; `headless` ⇒ all off); the per-capability
 * override `OPENWOP_PRESENTATION_<CAP>=on|off` wins. Read at capability-assembly /
 * route-mount time and threaded through the EXISTING single-source capability
 * functions — never a parallel discovery document, so advertise and serve stay
 * co-gated.
 */
export function presentationEnabled(cap: PresentationCapability): boolean {
  const override = process.env[`OPENWOP_PRESENTATION_${ENV_SUFFIX[cap]}`];
  if (override === 'on') return true;
  if (override === 'off') return false;
  return hostProfile() === 'full';
}
