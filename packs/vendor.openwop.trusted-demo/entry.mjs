/**
 * vendor.openwop.trusted-demo — the reference ADR 0367 Tier-1 (trusted) plugin
 * module. Served ONLY by the trusted lane after per-serve signature +
 * revocation verification, then dynamic-imported into the MAIN frame.
 *
 * Contract: `mount(el) → cleanup`. Because this runs main-frame, it uses the
 * host's design-system classes directly (the whole point of T1 — full UI
 * integration, no iframe seam) and never fetches an external origin.
 */
export function mount(el) {
  const card = document.createElement('div');
  card.className = 'surface-card u-gap-2 u-p-4';

  const head = document.createElement('div');
  head.className = 'u-flex u-items-center u-gap-2';
  const title = document.createElement('strong');
  title.textContent = 'Trusted demo plugin';
  const chip = document.createElement('span');
  chip.className = 'chip chip--success';
  chip.textContent = 'main frame';
  head.append(title, chip);

  const body = document.createElement('p');
  body.className = 'muted';
  body.textContent =
    'This module was signature-verified against an operator-pinned key at serve time and mounted by dynamic import — no iframe, full design-system access.';

  const btn = document.createElement('button');
  btn.type = 'button';
  let clicks = 0;
  const label = () => `Prove interactivity (${clicks})`;
  btn.textContent = label();
  const onClick = () => {
    clicks += 1;
    btn.textContent = label();
  };
  btn.addEventListener('click', onClick);

  card.append(head, body, btn);
  el.append(card);

  return () => {
    btn.removeEventListener('click', onClick);
    card.remove();
  };
}
