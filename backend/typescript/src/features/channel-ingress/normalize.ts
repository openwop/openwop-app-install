/**
 * ADR 1042 D7 — map one VERIFIED provider delivery to the channel core's message
 * shape. Pure. Returns null for anything that is not a person's text message
 * (status callbacks, edits, a bot's own messages — which would loop).
 */

export interface ChannelMessage {
  /** The chat the message arrived in; the reply goes back here and nowhere else. */
  chatId: string;
  /** A thread within the chat (Slack `thread_ts`, a Telegram topic). */
  threadId?: string;
  /** The platform id of the person who wrote it (WhatsApp: E.164). */
  senderId: string;
  /** The platform's stable id for this message (dedup + exchange key). */
  messageId: string;
  text: string;
  isGroup: boolean;
  /** The platform itself says the bot was addressed (a Slack app mention, a
   *  Discord command). Undefined ⇒ decide from the configured bot handle. */
  addressedByPlatform?: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const idStr = (v: unknown): string | undefined => (typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v));
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function e164(raw: string): string | null {
  let bare = raw.startsWith('whatsapp:') ? raw.slice('whatsapp:'.length) : raw;
  if (/^[1-9]\d{6,14}$/.test(bare)) bare = `+${bare}`;
  return /^\+[1-9]\d{6,14}$/.test(bare) ? bare : null;
}

export function normalizeChannelMessage(provider: string, body: Record<string, unknown>): ChannelMessage | null {
  switch (provider) {
    case 'telegram': {
      const m = rec(body.message);
      const chat = rec(m.chat);
      const from = rec(m.from);
      const chatId = idStr(chat.id);
      const senderId = idStr(from.id);
      const messageId = idStr(m.message_id);
      const text = str(m.text) ?? str(m.caption) ?? '';
      if (!chatId || !senderId || !messageId || from.is_bot === true) return null;
      const topic = idStr(m.message_thread_id);
      return { chatId, senderId, messageId, text, isGroup: chat.type !== 'private', ...(topic ? { threadId: topic } : {}) };
    }
    case 'discord': {
      // Application-command interactions only (free text needs the gateway worker, P2d).
      if (body.type !== 2) return null;
      const user = rec(rec(body.member).user ?? body.user);
      const data = rec(body.data);
      const chatId = str(body.channel_id);
      const senderId = str(user.id);
      const messageId = str(body.id);
      if (!chatId || !senderId || !messageId) return null;
      const options = Array.isArray(data.options) ? (data.options as unknown[]).map(rec) : [];
      const text = options.map((o) => str(o.value)).find((v) => v !== undefined) ?? '';
      return { chatId, senderId, messageId, text, isGroup: typeof body.guild_id === 'string', addressedByPlatform: true };
    }
    case 'slack': {
      const ev = rec(body.event);
      // A bot's own message (ours included) or an edit/join/etc. subtype never answers.
      if (ev.bot_id !== undefined || ev.subtype !== undefined) return null;
      if (ev.type !== 'message' && ev.type !== 'app_mention') return null;
      const chatId = str(ev.channel);
      const senderId = str(ev.user);
      const ts = str(ev.ts);
      if (!chatId || !senderId || !ts) return null;
      const isGroup = ev.channel_type !== 'im';
      // In a channel Slack sends BOTH a `message` and an `app_mention` for one
      // mention; only the mention answers (so a mention is never answered twice).
      return {
        chatId, senderId, messageId: str(ev.client_msg_id) ?? ts, text: str(ev.text) ?? '', isGroup,
        threadId: str(ev.thread_ts) ?? ts, addressedByPlatform: ev.type === 'app_mention',
      };
    }
    case 'whatsapp-twilio': {
      const from = str(body.From);
      const sid = str(body.MessageSid);
      const sender = from ? e164(from) : null;
      if (!sender || !sid || typeof body.Body !== 'string') return null;
      return { chatId: sender, senderId: sender, messageId: sid, text: body.Body, isGroup: false };
    }
    case 'whatsapp-cloud': {
      for (const e of Array.isArray(body.entry) ? (body.entry as unknown[]).map(rec) : []) {
        for (const c of Array.isArray(e.changes) ? (e.changes as unknown[]).map(rec) : []) {
          const msgs = Array.isArray(rec(c.value).messages) ? (rec(c.value).messages as unknown[]).map(rec) : [];
          const m = msgs[0];
          if (!m) continue;
          const sender = str(m.from) ? e164(str(m.from)!) : null;
          const id = str(m.id);
          if (!sender || !id) return null;
          return { chatId: sender, senderId: sender, messageId: id, text: str(rec(m.text).body) ?? '', isGroup: false };
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/** Is the bot addressed? The platform's word wins; else `@<handle>` in the text.
 *  No handle configured ⇒ a group message is never addressed (fail closed). */
export function isAddressed(msg: ChannelMessage, botHandle: string | undefined): boolean {
  if (msg.addressedByPlatform !== undefined) return msg.addressedByPlatform;
  if (!botHandle) return false;
  return msg.text.toLowerCase().includes(`@${botHandle.toLowerCase()}`);
}
