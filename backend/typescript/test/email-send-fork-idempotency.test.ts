/**
 * WF-EM-6 — the `core.openwop.integration.email-send` idempotency key must be
 * FORK-STABLE. A send is a non-idempotent side effect; the host `emailSentLedger`
 * dedups on the node-supplied `idempotencyKey`. Before this fix the node baked
 * `ctx.runId` into that key, and a `:fork` mints a new runId — so the fork
 * derived a fresh key, missed the ledger, and RE-SENT the email.
 *
 * This invokes the node twice with ctxs that differ ONLY in `runId` (a fork of
 * the same node + payload) and asserts the derived key is identical, so the
 * ledger suppresses the re-send. Born red on the pre-WF-EM-6 pack (runId in key).
 */
import { describe, expect, it } from 'vitest';

type EmailCtx = {
  runId: string;
  nodeId: string;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
  email: { send: (args: { idempotencyKey?: string }) => Promise<unknown> };
};
type EmailSend = (ctx: EmailCtx) => Promise<{ outputs: { idempotencyKey: string } }>;

async function loadEmailSend(): Promise<EmailSend> {
  // The integration pack is untyped ESM (loaded via the pack loader in prod, no
  // shipped .d.ts). A static specifier is required so vitest resolves it at
  // runtime; a variable specifier is not analyzable and fails to load. tsc has no
  // declaration for it, so the one suppression below is justified per the test-file
  // exception in the code-review policy.
  // @ts-expect-error TS7016 — untyped ESM pack imported for a node-level unit test (WF-EM-6); vitest resolves it at runtime.
  const mod = (await import('../../../packs/core.openwop.integration/index.mjs')) as { emailSend: EmailSend };
  return mod.emailSend;
}

function ctxFor(runId: string, captured: { key?: string }): EmailCtx {
  return {
    runId,
    nodeId: 'email-node-1',
    config: { from: 'a@x.com', provider: 'sendgrid' },
    inputs: { to: 'b@y.com', subject: 'Welcome', text: 'hello', html: '<b>hello</b>' },
    email: {
      send: async (args: { idempotencyKey?: string }) => {
        captured.key = args.idempotencyKey;
        return { sent: true, messageId: 'm-1', provider: 'sendgrid' };
      },
    },
  };
}

describe('WF-EM-6 — email-send idempotency key is fork-stable', () => {
  it('a :fork (new runId, same node + payload) derives the SAME idempotencyKey', async () => {
    const emailSend = await loadEmailSend();
    const parent: { key?: string } = {};
    const forked: { key?: string } = {};

    await emailSend(ctxFor('run-parent', parent));
    await emailSend(ctxFor('run-forked-9c2', forked)); // a :fork mints a new runId

    expect(parent.key).toBeTruthy();
    // The whole point: runId must NOT be in the key, or the ledger re-sends on fork.
    expect(forked.key).toBe(parent.key);
  });

  it('a different recipient/subject/body DOES change the key (not over-dedup)', async () => {
    const emailSend = await loadEmailSend();
    const a: { key?: string } = {};
    const b: { key?: string } = {};
    const ctxA = ctxFor('run-x', a);
    const ctxB = ctxFor('run-x', b);
    ctxB.inputs = { ...ctxB.inputs, subject: 'A different subject' };
    await emailSend(ctxA);
    await emailSend(ctxB);
    expect(b.key).not.toBe(a.key);
  });
});
