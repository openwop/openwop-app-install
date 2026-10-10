/**
 * The ARIA 1.2 combobox wiring between the composer textarea and its pickers
 * (`/` commands+workflows, `@` agents, `@@` boards) — grade-ux CHATUX-1.
 *
 * Focus never leaves the textarea (the pickers drive the highlight from a
 * window key listener), so a screen-reader user heard NOTHING when a picker
 * opened or the highlight moved: the options had no ids and the textarea no
 * `aria-activedescendant`. Each picker now reports its highlighted option's id;
 * the composer points `aria-activedescendant` / `aria-controls` /
 * `aria-expanded` at it.
 */
import { useEffect } from 'react';

export interface ComboboxWiring {
  /** The id the picker's `role="listbox"` element carries. */
  listboxId: string;
  /** Called with the highlighted option's id, or null when the picker shows no options. */
  onActiveChange: (activeOptionId: string | null) => void;
}

export function optionId(listboxId: string, index: number): string {
  return `${listboxId}-opt-${index}`;
}

/** Report the highlighted option to the composer (and null on close/unmount). */
export function useReportActiveOption(
  wiring: ComboboxWiring | undefined,
  open: boolean,
  count: number,
  selectedIdx: number,
): void {
  const report = wiring?.onActiveChange;
  const listboxId = wiring?.listboxId;
  useEffect(() => {
    if (!report || !listboxId) return;
    report(open && count > 0 ? optionId(listboxId, Math.min(selectedIdx, count - 1)) : null);
  }, [report, listboxId, open, count, selectedIdx]);
  useEffect(() => () => { report?.(null); }, [report]);
}
