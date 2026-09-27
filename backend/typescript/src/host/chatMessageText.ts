/**
 * THE canonical extractor for the plain text inside a stored chat `content` value
 * (ADR 0192 D5) — raw text, or the serialized ChatMessage envelope (string content
 * or content-part arrays). One copy so mention parsing (`chatMessageBus`), the
 * channel post/dispatch path (`channelService`), and the channel-activity notifier
 * (`channelActivityNotify`) never drift. Lives in its own module so those consumers
 * don't form an import cycle through `chatMessageBus`.
 */
export function extractMessageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { content?: unknown };
    if (typeof parsed?.content === 'string') return parsed.content;
    if (Array.isArray(parsed?.content)) {
      return (parsed.content as Array<{ type?: string; text?: string }>)
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n');
    }
  } catch { /* plain-text record */ }
  return content;
}
