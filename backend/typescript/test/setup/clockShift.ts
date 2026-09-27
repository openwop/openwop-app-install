/**
 * OPTIONAL clock-shift lane — detonates latent DATE BOMBS.
 *
 * A test that mixes a FIXED-date fixture with a real-clock read passes until a
 * calendar date, then fails long after the commit that armed it and implicates
 * whoever is nearest. `anon-tenant-lifecycle` did exactly that (#2623): a
 * fixture at 2026-07-13T12:00Z crossed a `now - 14d` cutoff at 12:00Z on
 * 2026-07-27, and `main` went red with nobody having touched retention.
 *
 * Running the suite with the clock advanced surfaces that class BEFORE it fires.
 * Opt-in (`OPENWOP_CI_CLOCKSHIFT=1`), like the live-adapter and e2e lanes, because
 * it doubles suite time and the class is rare.
 *
 * Set `OPENWOP_CLOCKSHIFT_DAYS` to choose the horizon (default 365).
 */
const DAYS = Number(process.env.OPENWOP_CLOCKSHIFT_DAYS ?? '365');
const SHIFT = DAYS * 86_400_000;

const RealDate = Date;
const realNow = Date.now.bind(Date);

class ShiftedDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date> | []) {
    if (args.length === 0) { super(realNow() + SHIFT); } else { super(...(args as ConstructorParameters<typeof Date>)); }
  }
  static override now(): number { return realNow() + SHIFT; }
}

globalThis.Date = ShiftedDate as unknown as DateConstructor;
