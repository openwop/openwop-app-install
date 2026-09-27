/**
 * OPTIONAL clock-shift lane for the FRONTEND — detonates latent DATE BOMBS.
 *
 * The backend has had this since #2623 (`backend/typescript/test/setup/clockShift.ts`).
 * The frontend did not, and the gap was not theoretical: on 2026-08-18
 * `PublicBookingManagePage.test.tsx` went red on `main` and on every branch at
 * the same instant, because it asserted `(to - from)/DAY === 15` over an
 * unmocked `Date.now()` while `BookingMonthGrid` clamps that window to
 * `min(startOfNextMonth + 36h, now + 15d)`. It passed through the 17th and
 * failed from the 18th, a day worse each day.
 *
 * The reason it survived is the part worth writing down: `scripts/ci.sh`'s
 * date-bomb sweep runs `( cd "$ROOT/backend/typescript" … )` and nothing else.
 * So the sweep could have been ON for every run since that test was written and
 * would still never have entered the workspace the bomb lived in. That is not a
 * gate whose assertion fails to fire — it is a gate whose SCOPE excludes the
 * defect, which reads identically in the log.
 *
 * Ten frontend test files reference `Date.now()`. Most are inert; this lane is
 * how we find out which are not, before a calendar date tells us.
 *
 * Opt-in (`OPENWOP_CI_CLOCKSHIFT=1`) for the same reason as the backend's: it
 * doubles suite time and the class is rare. `OPENWOP_CLOCKSHIFT_DAYS` chooses
 * the horizon (default 365).
 *
 * NOTE it shifts `Date` only, exactly as the backend lane does — a test that
 * pins its own clock with `vi.setSystemTime` is unaffected, which is correct:
 * such a test has already stated the instant it means, and that is the fix this
 * lane is meant to produce.
 */
const DAYS = Number(import.meta.env?.VITE_CLOCKSHIFT_DAYS ?? process.env.OPENWOP_CLOCKSHIFT_DAYS ?? '365');
const SHIFT = DAYS * 86_400_000;

const RealDate = Date;
const realNow = Date.now.bind(Date);

class ShiftedDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date> | []) {
    if (args.length === 0) {
      super(realNow() + SHIFT);
    } else {
      super(...(args as ConstructorParameters<typeof Date>));
    }
  }

  static override now(): number {
    return realNow() + SHIFT;
  }
}

globalThis.Date = ShiftedDate as unknown as DateConstructor;
