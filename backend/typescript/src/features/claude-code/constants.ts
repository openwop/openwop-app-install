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

/** sha256 over a stable serialization of the consent text — what an acknowledgement binds to. */
export function consentHash(text: ConsentText = CONSENT_TEXT): string {
  const stable = JSON.stringify([text.version, text.quote, text.source, text.fetchedAt, text.acknowledgements]);
  return createHash('sha256').update(stable).digest('hex');
}
