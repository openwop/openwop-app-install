/**
 * A boot step that is best-effort must also be BOUNDED — otherwise "a failure
 * never blocks boot" holds only for failures that are fast.
 *
 * MEASURED 2026-09-21: the demo showcase seed (1,090 workforce runs, inserted
 * one by one before `listen`) had been failing FAST on a missing table for three
 * weeks, which is the only reason boot was healthy. The deploy that created the
 * table let it do its real work, it outran Cloud Run's 4-minute startup probe,
 * and revision `00728-7q5` never became Ready — nor would any new instance of
 * any revision on that database.
 *
 * `withinBootBudget` awaits `work` for at most `budgetMs`. If the budget lapses,
 * it returns `{ settled: false }` and `work` keeps running unobserved; the
 * caller must attach its own settlement logging BEFORE calling (so a late
 * rejection is never unhandled). Only use it for idempotent steps that a later
 * boot re-runs — a deferred step on a CPU-throttled instance may not finish.
 */
export async function withinBootBudget<T>(
  work: Promise<T>,
  budgetMs: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: NodeJS.Timeout | undefined;
  const lapse = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then((value) => ({ settled: true as const, value })), lapse]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
