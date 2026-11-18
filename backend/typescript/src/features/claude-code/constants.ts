/**
 * ADR 0785 — Claude Code local agent host: the feature's fixed vocabulary.
 *
 * The consent text is data, not UI copy: its content hash is what a user
 * acknowledges (the ADR 0180 consent-record shape), so a wording change is a new
 * version that requires a fresh acknowledgement. The Anthropic sentence is quoted
 * VERBATIM with its source and fetch date (ADR 0756's citation), because D2 of
 * ADR 0785 accepts the risk it describes rather than hiding it.
 */
import { createHash } from 'node:crypto';
import { VENDOR_ROOT, vendorPath } from '../../middleware/protocolVersion.js';

export const CLAUDE_CODE_TOGGLE = 'claude-code';

/** ADR 0785 D2 lever 1 — the operator gate. Unset ⇒ nothing served, nothing advertised. */
export const CLAUDE_CODE_OPERATOR_ENV = 'OPENWOP_CLAUDE_CODE_AT_OWN_RISK';

export function claudeCodeOperatorEnabled(): boolean {
  return process.env[CLAUDE_CODE_OPERATOR_ENV] === 'true';
}

/** Registered on the `/v1` twin (ADR 0654), reachable at the canonical
 *  version-agnostic `/host/<org>/claude-code` root too (ADR 0652). Built from the
 *  constants so the ADR 0642 v1-reliance ratchet sees no new literal. */
export const CLAUDE_CODE_BASE = vendorPath('/claude-code');

/** The canonical root a client should call — it does not retire with `/v1`. */
export const CLAUDE_CODE_CANONICAL_BASE = `${VENDOR_ROOT}/claude-code`;

/** The ONLY unauthenticated prefix (device start + poll). Registered in
 *  `PUBLIC_PATH_PREFIXES`; a test pins that nothing else under the base is public. */
export const CLAUDE_CODE_PUBLIC_PREFIX = `${CLAUDE_CODE_BASE}/pair/device`;

/**
 * ADR 0785 D3 — the scopes a paired device's developer key carries. NEVER
 * `approvals:respond`: an agent must not answer its own permission prompt. (The
 * scope's absence is not the whole guard — the PendingApproval claim route checks
 * no scope — so P4's decision branch also refuses api-key principals; see the
 * ADR's D3 correction.)
 */
export const DEVICE_KEY_SCOPES: readonly string[] = ['workspace:read', 'workspace:write'];

/**
 * ADR 1136 P2a — what a paired device may do. A pairing grants exactly ONE:
 * a terminal device hosts Claude Code (ADR 0785), and a browser device hosts
 * the person's own browser for computer-use (ADR 1136 lane A). A key paired for
 * the terminal cannot drive a browser and the reverse; a change is a re-pair.
 * Rows paired before this have no capabilities and read as `terminal`.
 */
export const DEVICE_CAPABILITIES = ['terminal', 'browser'] as const;
export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];

/** A browser device's key declares only this scope. No route grants it, so the
 *  key can open its device socket and nothing else. (An EMPTY declaration would
 *  permit everything; see `keyDeclarationPermits`.) */
export const BROWSER_DEVICE_KEY_SCOPES: readonly string[] = ['device:browser'];

export function deviceKeyScopesFor(capability: DeviceCapability): readonly string[] {
  return capability === 'browser' ? BROWSER_DEVICE_KEY_SCOPES : DEVICE_KEY_SCOPES;
}

/** The one capability a pairing asked for: `terminal` when absent, null when
 *  the value is anything other than one known capability. */
export function parseDeviceCapability(raw: unknown): DeviceCapability | null {
  if (raw === undefined || raw === null) return 'terminal';
  return typeof raw === 'string' && (DEVICE_CAPABILITIES as readonly string[]).includes(raw) ? raw as DeviceCapability : null;
}

/** Paired-device key lifetime (ADR 0785 D3: 90 days by default). */
export const DEVICE_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Device-code lifetime and the poll interval the companion is told to honour. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_POLL_INTERVAL_S = 5;

/** Key-name prefix: how a developer key is recognisable as a paired device. */
export const DEVICE_KEY_NAME_PREFIX = 'claude-code:';

export const CONSENT_VERSION = 'claude-code-consent-v1';

export interface ConsentText {
  version: string;
  /** The verbatim provider sentence the user is accepting the risk of. */
  quote: string;
  source: string;
  fetchedAt: string;
  /** What the user acknowledges, in the host's words. */
  acknowledgements: string[];
}

export const CONSENT_TEXT: ConsentText = {
  version: CONSENT_VERSION,
  quote:
    'Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, '
    + 'or to route requests through Free, Pro, or Max plan credentials on behalf of their users.',
  source: 'https://code.claude.com/docs/en/legal-and-compliance',
  fetchedAt: '2026-09-26',
  acknowledgements: [
    'Claude Code runs on my own machine, under whatever credential my own claude CLI is signed in with. This app never sees, stores or forwards that credential.',
    'Using an Anthropic API key (or Bedrock / Vertex) on the companion is the supported path. If I use a Claude Free, Pro or Max login instead, I do so at my own risk, and any enforcement falls on my Anthropic account.',
    'Letting this app send work to Claude Code on its own is a separate choice I make per device, later.',
  ],
};

export const BROWSER_CONSENT_VERSION = 'browser-device-consent-v1';

/** ADR 1136 D4/D5 — what a person accepts when they pair a browser device. */
export const BROWSER_CONSENT_TEXT: ConsentText = {
  version: BROWSER_CONSENT_VERSION,
  quote: 'The browser agent works in a browser window on your own machine, which you can watch and close at any time.',
  source: 'https://github.com/openwop/openwop-app/blob/main/docs/adr/1136-browser-executors-for-computer-use.md',
  fetchedAt: '2026-11-16',
  acknowledgements: [
    'A separate browser window opens on this machine, with its own profile for this workspace. The agent reads and acts only inside that window, and only on the sites each task allows.',
    'I sign in to sites myself. The agent never types passwords, one-time codes or card numbers.',
    'Each submit, link to a new page, purchase or message waits for my approval in the app. If a page does something I did not approve, the task stops.',
    'This device can drive a browser only. It cannot run Claude Code or read this workspace\'s data.',
  ],
};

/** The consent a pairing for `capability` shows and binds to. */
export function consentTextFor(capability: DeviceCapability): ConsentText {
  return capability === 'browser' ? BROWSER_CONSENT_TEXT : CONSENT_TEXT;
}

/** sha256 over a stable serialization of the consent text — what an acknowledgement binds to. */
export function consentHash(text: ConsentText = CONSENT_TEXT): string {
  const stable = JSON.stringify([text.version, text.quote, text.source, text.fetchedAt, text.acknowledgements]);
  return createHash('sha256').update(stable).digest('hex');
}
