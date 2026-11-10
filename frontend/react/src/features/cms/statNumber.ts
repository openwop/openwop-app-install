/**
 * ADR 1038 D3 — whether a stat's title can count up, and to what.
 *
 * A stat counts up only when its title is ONE whole number, at most nine digits
 * and no leading zero, with an optional short prefix and suffix that hold no
 * digits: `130`, `$4`, `R$ 4`, `98%`, `98 %`, `10k+`, `10 mil+`. The prefix may
 * end in one space (`R$ 4`, `US$ 4`, the pt-BR and es spacing) and the suffix
 * may start with one (`98 %`, `4 €`, the fr spacing). `2,400`, `3.5` and `007` do NOT count
 * (separators are left still, so a localized figure is never reformatted, and a
 * counter can only end on the number as written). Anything else returns null
 * and stays still.
 *
 * Only the SPA reads it: the validator keeps `count` by layout, and crawlers and
 * the custom-domain stylesheet show the plain title (ADR 1038 D3 correction).
 */
export interface CountableStat { prefix: string; value: number; suffix: string }

const COUNTABLE = /^([^\d\s]{0,3}[ \u00a0\u202f]?)(0|[1-9]\d{0,8})([^\d]{0,5})$/;

export function countableStat(title: string): CountableStat | null {
  const m = COUNTABLE.exec(title.trim());
  if (!m) return null;
  const value = Number(m[2]);
  return Number.isSafeInteger(value) ? { prefix: m[1] ?? '', value, suffix: m[3] ?? '' } : null;
}
