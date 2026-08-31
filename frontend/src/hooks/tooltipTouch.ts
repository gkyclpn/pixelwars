// Touch devices have no hover, so [data-tip] hints are reached via long-press:
// hold ~450ms → the tooltip appears.
// The long press is informational; the click is swallowed and no button action fires.
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 12;

let timer: number | undefined;
let active: HTMLElement | null = null;
let startX = 0;
let startY = 0;

function clear() {
  window.clearTimeout(timer);
  timer = undefined;
  if (active) {
    active.classList.remove("tip-on");
    active = null;
  }
}

document.addEventListener(
  "touchstart",
  (ev) => {
    clear();
    const el = (ev.target as HTMLElement | null)?.closest?.("[data-tip]") as HTMLElement | null;
    if (!el) return;
    const t = ev.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    timer = window.setTimeout(() => {
      active = el;
      el.classList.add("tip-on");
    }, LONG_PRESS_MS);
  },
  { passive: true },
);

document.addEventListener(
  "touchmove",
  (ev) => {
    if (timer === undefined && !active) return;
    const t = ev.touches[0];
    if (Math.hypot(t.clientX - startX, t.clientY - startY) > MOVE_TOLERANCE) clear();
  },
  { passive: true },
);

document.addEventListener(
  "touchend",
  (ev) => {
    if (active) ev.preventDefault(); // swallow the click on long-press — info only
    clear();
  },
  { passive: false },
);

document.addEventListener("touchcancel", clear, { passive: true });
