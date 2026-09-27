/**
 * The ONE notification type → icon mapping, shared by the bell drawer
 * (`NotificationPanel`) and the full inbox (`NotificationsPage`) so the two can't
 * drift (grade-ux DL-UX-4 — the drawer previously gave `approval_needed` and
 * `failed` the same glyph, indistinguishable without color). Distinct glyphs mean
 * a type reads without relying on the tone color (WCAG 1.4.1).
 */
import type { JSX } from 'react';
import { AlertIcon, CheckSquareIcon, InfoIcon, MegaphoneIcon, MessageSquareIcon, ScaleIcon } from '../ui/icons/index.js';

export function notificationTypeIcon(type: string, size = 14): JSX.Element {
  switch (type) {
    case 'openwop-app.workflow.approval-needed':
    case 'workflow.input_needed':
      return <ScaleIcon size={size} />;
    case 'workflow.failed':
      return <AlertIcon size={size} />;
    case 'workflow.completed':
      return <CheckSquareIcon size={size} />;
    case 'system.alert':
      return <MegaphoneIcon size={size} />;
    case 'chat.channel_post':
    case 'comment.added':
    case 'comment.reply':
      return <MessageSquareIcon size={size} />;
    default:
      return <InfoIcon size={size} />;
  }
}
