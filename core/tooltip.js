// tooltips: anything with a title, in latticework or lattice, shows it in one
// of these rather than the browser's own. the title stays where the words
// live (and what screen readers read): it's lifted off while the pointer's
// over it, so the browser's doesn't show too, and put back after
const SCOPE = ".knitoutjs-editor-tool";
// the first waits this long; for a while after one shuts, the next doesn't
const DELAY = 450;
const WARM = 400;
const GAP = 6;

let installed = false;

export function tooltips() {
  if (installed || typeof document === "undefined") return;
  installed = true;

  const tip = document.createElement("div");
  tip.className = "knitoutjs-tooltip";
  tip.popover = "manual";
  tip.setAttribute("aria-hidden", "true");
  document.body.append(tip);

  let over = null; // the element it's for
  let lifted = false; // its title's off it, while the pointer's there
  let timer = null;
  let warmUntil = 0;
  let pointer = { x: 0, y: 0 };

  const titled = (target) => {
    const el = target?.closest?.("[title], [data-tip]");
    return el && el.closest(SCOPE) ? el : null;
  };

  function lift(el) {
    const title = el.getAttribute("title");
    if (title == null) return;
    el.dataset.tip = title;
    el.removeAttribute("title");
    lifted = true;
  }
  function putBack(el) {
    // (if it's been given a new one meanwhile, that one stays)
    if (lifted && !el.hasAttribute("title") && el.dataset.tip != null) el.setAttribute("title", el.dataset.tip);
    delete el.dataset.tip;
    lifted = false;
  }

  function place(el, byPointer) {
    const rect = el.getBoundingClientRect();
    const { width, height } = tip.getBoundingClientRect();
    // a big thing (a row, a pane): by the pointer. a small one: under it
    const big = rect.height > 48;
    const x = (byPointer || big ? pointer.x : rect.left + rect.width / 2) - width / 2;
    let y = (byPointer && big ? pointer.y + 16 : rect.bottom) + GAP;
    if (y + height > innerHeight - GAP) y = (big ? pointer.y : rect.top) - height - GAP;
    tip.style.left = `${Math.round(Math.max(GAP, Math.min(x, innerWidth - width - GAP)))}px`;
    tip.style.top = `${Math.round(Math.max(GAP, y))}px`;
  }

  function show(el, text, byPointer) {
    if (!el.isConnected || !text.trim()) return;
    tip.textContent = text;
    if (!tip.matches(":popover-open")) tip.showPopover();
    place(el, byPointer);
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    if (tip.matches(":popover-open")) {
      tip.hidePopover();
      warmUntil = Date.now() + WARM;
    }
  }

  function leave() {
    hide();
    if (over) putBack(over);
    over = null;
  }

  document.addEventListener(
    "pointerover",
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      const el = titled(event.target);
      if (el === over) {
        // given a title again while it was off (it's been re-rendered)
        if (el && el.hasAttribute("title")) {
          lift(el);
          if (tip.matches(":popover-open")) show(el, el.dataset.tip ?? "", true);
        }
        return;
      }
      leave();
      if (!el) return;
      over = el;
      lift(el);
      const text = el.dataset.tip ?? "";
      timer = setTimeout(() => show(el, text, true), Date.now() < warmUntil ? 0 : DELAY);
    },
    true,
  );
  document.addEventListener(
    "pointermove",
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "pointerout",
    (event) => {
      if (over && !over.contains(event.relatedTarget)) leave();
    },
    true,
  );
  // anything done shuts it (it comes back next time round)
  for (const type of ["pointerdown", "wheel", "keydown"]) document.addEventListener(type, hide, true);
  addEventListener("blur", leave);

  // from the keyboard: the title's left on (it's what's read out)
  document.addEventListener(
    "focusin",
    (event) => {
      const el = titled(event.target);
      if (!el || el !== event.target || !el.matches(":focus-visible") || over) return;
      clearTimeout(timer);
      timer = setTimeout(() => show(el, el.getAttribute("title") ?? el.dataset.tip ?? "", false), DELAY);
    },
    true,
  );
  document.addEventListener(
    "focusout",
    () => {
      if (!over) hide();
    },
    true,
  );
}
