/**
 * ADR 1136 D3 — every browser operation is tiered closed-world, from the
 * executor's own element report, and an unknown case fails toward the person.
 *
 * The tier decides who approves (ADR 0418 §2, ADR 0894 D3): observe and interact
 * auto-advance inside a started task; commit halts for the opener; a credential
 * field is never filled at all (ADR 1136 D5 — the person signs in, the model
 * never does), so it maps to the `credential` kind the session loop refuses.
 *
 * The result is a `CuActionKind`, so the existing loop and its `tierOf` apply
 * unchanged: this table chooses the kind, `tierOf` reads it.
 *
 * What this table is NOT (release-manager review, 2026-11-16):
 *  - It is not the credential boundary. It trusts the page's own element
 *    report, and a hostile allowlisted page can label a password field as a
 *    plain textbox. The boundary is that the model never holds a secret
 *    (credentials stay host-side under BYOK, and the person signs in, D5) and
 *    typed text never persists (labels are host-composed, D8). Detection here
 *    only refuses the honest case early.
 *  - It is a reading of intent, not a guarantee of effect. A page script can
 *    turn any interact step (a checkbox click, Tab in a field) into a form
 *    submit or a request. The loop catches a navigation off the allowlist on
 *    the next step, because every action carries the current page URL. It
 *    cannot see a same-origin submit that a script fires. P2's real-browser
 *    witness must show that a script-bound handler cannot turn an interact
 *    step into a submit with no commit approval (for example, by watching the
 *    executor's navigations and form submissions after an interact step).
 *
 * P2 entry criterion, beside multi-instance (`executorRegistry.ts`): the
 * response is defined as well as the detection. When the executor reports a
 * navigation or a form submission after an interact step that had no commit
 * approval:
 *  - the session stops fail-closed: no further driver step;
 *  - the step is recorded `uncertain` and is never retried;
 *  - the next executor call is a snapshot, kept for the record;
 *  - the session ends `failed` with a typed `unapproved_effect`, and is never
 *    resumed (the person may start a new session if they choose);
 *  - the opener is told what happened in plain words (the trajectory and the
 *    session's end state).
 */
import type { CuActionKind, CuTier } from './adapter.js';
import { tierOf } from './adapter.js';
import type { ElementReport, ExecutorOp } from './executorProtocol.js';

/** Roles whose click only changes what is on the page. Anything not here, and
 *  any element that submits, is commit. */
const INTERACT_CLICK_ROLES: ReadonlySet<string> = new Set([
  'checkbox', 'radio', 'switch', 'tab', 'option', 'combobox', 'listbox', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'treeitem', 'disclosure', 'textbox', 'searchbox', 'spinbutton', 'slider',
]);

/** Roles that accept typed text. */
const TEXT_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/** Autocomplete tokens that name a secret or a payment detail. */
const CREDENTIAL_AUTOCOMPLETE = /^(?:current-password|new-password|one-time-code|cc-(?:name|given-name|additional-name|family-name|number|exp|exp-month|exp-year|csc|type))$/;

/** A field the model must never fill: a password, a one-time code, a card. */
export function isCredentialField(e: ElementReport): boolean {
  if (e.inputType?.toLowerCase() === 'password') return true;
  const tokens = (e.autocomplete ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.some((t) => CREDENTIAL_AUTOCOMPLETE.test(t));
}

export interface Classified {
  kind: CuActionKind;
  tier: CuTier;
  /** The target URL the allowlist must judge (navigation, link click). */
  url?: string;
  /** Host-composed step label. Never contains typed text (ADR 1136 D8). */
  label: string;
}

const quote = (name: string): string => `"${name.replace(/\s+/g, ' ').trim().slice(0, 80)}"`;

function make(kind: CuActionKind, label: string, url?: string): Classified {
  return { kind, tier: tierOf({ actionId: '', kind, description: '' }), label, ...(url ? { url } : {}) };
}

/**
 * Classify one operation against the element it targets (`element` is the
 * snapshot's report for `op.ref`, or undefined when the op has no ref or the
 * ref is unknown). An unknown op, an unknown role, or a ref the page did not
 * report all classify as commit.
 */
export function classifyOp(op: ExecutorOp, element: ElementReport | undefined): Classified {
  switch (op.op) {
    case 'snapshot':
      return make('read', 'Read the page');
    case 'screenshot':
      return make('screenshot', 'Take a screenshot');
    case 'scroll':
      return make('scroll', op.dy >= 0 ? 'Scroll down' : 'Scroll up');
    case 'navigate':
      return make('navigate', 'Open a page', op.url);
    case 'click': {
      if (!element) return make('submit', 'Click an element the page did not report');
      if (element.role === 'link') {
        // A link opens a page: commit, with its target judged by the allowlist.
        return make('navigate', `Open the link ${quote(element.name)}`, element.href);
      }
      if (element.submits === true) return make('submit', `Submit with ${quote(element.name)}`);
      if (INTERACT_CLICK_ROLES.has(element.role)) return make('click', `Click ${quote(element.name)}`);
      // A plain `button` that does not submit can still send, buy or delete:
      // without a closed reading it is commit.
      return make('submit', `Click ${quote(element.name)}`);
    }
    case 'type': {
      if (!element) return make('submit', 'Type into an element the page did not report');
      if (isCredentialField(element)) return make('credential', `Fill ${quote(element.name)}`);
      if (TEXT_ROLES.has(element.role)) return make('type', `Type into ${quote(element.name)}`);
      return make('submit', `Type into ${quote(element.name)}`);
    }
    case 'press': {
      if (!element) return make('submit', 'Press a key on an element the page did not report');
      if (isCredentialField(element)) return make('credential', `Press ${op.key} in ${quote(element.name)}`);
      // Enter can submit the form around any field.
      if (op.key === 'Enter') return make('submit', `Press Enter in ${quote(element.name)}`);
      return make('click', `Press ${op.key} in ${quote(element.name)}`);
    }
    default: {
      const unknown: never = op;
      void unknown;
      return make('submit', 'An operation this host does not know');
    }
  }
}

/** Exported for the closed-world test: the table's rows, so a dropped row reds. */
export const TIER_TABLE = { INTERACT_CLICK_ROLES, TEXT_ROLES } as const;
