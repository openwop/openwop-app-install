/**
 * ADR 0955 D8 — the SMS body rules, in one place for the template store and the journey
 * surface. (The `send-sms` pack node carries its own copy for bodies that never touch the
 * host's template store; it is standalone ESM and cannot import this.)
 */

/** GSM-7 basic set (the common characters). Anything outside it is sent UCS-2. */
const GSM7 = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;

/** Segment count: 160/153 characters for GSM-7, 70/67 for UCS-2. */
export function smsSegments(text: string): number {
  const len = [...text].length;
  if (GSM7.test(text)) return len <= 160 ? 1 : Math.ceil(len / 153);
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

export const MAX_SMS_SEGMENTS = 10;

/** Why a MARKETING SMS body is refused, or null. Every marketing text must say how to opt out. */
export function smsBodyProblem(text: string): string | null {
  if (!text.trim()) return 'The text is empty.';
  // The opt-out keyword is STOP in every language Twilio handles, so the rule is the keyword
  // itself, uppercase, as a word ("Reply STOP", "Responde STOP"; not "stop by our store").
  if (!/\bSTOP\b/.test(text)) return 'A marketing text must tell the person how to opt out, with the word STOP (e.g. "Reply STOP to opt out").';
  const n = smsSegments(text);
  if (n > MAX_SMS_SEGMENTS) return `The text is ${n} segments; the limit is ${MAX_SMS_SEGMENTS}.`;
  return null;
}
