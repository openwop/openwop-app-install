/**
 * feature.notifications.nodes — an in-app notification node over
 * `ctx.features.notifications` (ADR 0014 surface seam). role:"action"; outputs are
 * recorded so replay/fork read the recorded verdict rather than re-notifying.
 *
 * REPLACES `core.openwop.integration.notification-push` FOR CHAINS. That node's
 * input schema requires `deviceToken` — a per-recipient runtime value no chain
 * author can know. All 55 chain nodes across 53 packs left it unbound, so the Expo
 * adapter POSTed `to: undefined`, errored, and the node returned
 * `status:'success'` with `sent:false`. A run whose only outbound action failed
 * completed GREEN. The device-push node still exists for a caller that genuinely
 * has a device token; it is simply not what a chain wants.
 *
 * Pure-JS, Node-20 stdlib only.
 */

function ensureNotifications(ctx) {
  const surface = ctx.features && ctx.features.notifications;
  if (!surface || typeof surface.emit !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.notifications — the Notifications feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.notifications' },
    );
  }
  return surface;
}

/**
 * WHO comes from config, WHAT comes from inputs. That split is deliberate: the
 * audience is an authoring decision the chain author must make explicitly, while
 * the title/message are runtime values an upstream node can produce.
 */
export async function notify(ctx) {
  const notifications = ensureNotifications(ctx);
  const config = ctx.config ?? {};
  const inputs = ctx.inputs ?? {};

  const result = await notifications.emit({
    audience: config.audience,
    type: config.type,
    priority: config.priority,
    title: inputs.title,
    message: inputs.message,
  });

  // Surface the verdict verbatim. Deliberately NOT collapsed to
  // `status:'success'` with the failure buried in a field — that shape is the
  // defect this node exists to remove. A refusal is still a completed node (a
  // notification is a side-channel; failing the run would be worse), but it is
  // reported honestly and is visible in the recorded outputs.
  return {
    status: 'success',
    outputs: {
      emitted: result.emitted === true,
      audience: typeof result.audience === 'string' ? result.audience : '',
      ...(result.reason ? { reason: result.reason } : {}),
    },
  };
}

export const nodes = {
  'feature.notifications.nodes.notify': notify,
};
