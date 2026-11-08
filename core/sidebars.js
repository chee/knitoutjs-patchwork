import { createSignal } from "solid-js";
import html from "solid-js/html";

export const MIN_WIDTH = 140;
export const MAX_WIDTH = 480;
// dragged narrower than this, a sidebar closes
const CLOSE_BELOW = 90;

// remembered on this device
export function remembered(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}
export function remember(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/**
 * a sidebar's open and width, remembered as `lattice:<name>:open` and
 * `lattice:<name>:width`
 */
export function sidebarState(name, width) {
  const [open, setOpenSignal] = createSignal(remembered(`lattice:${name}:open`, true));
  const [size, setSizeSignal] = createSignal(remembered(`lattice:${name}:width`, width));
  return {
    open,
    width: size,
    defaultWidth: width,
    setOpen(value) {
      setOpenSignal(value);
      remember(`lattice:${name}:open`, value);
    },
    setWidth(value) {
      setSizeSignal(value);
      remember(`lattice:${name}:width`, value);
    },
  };
}

/**
 * the handle along a sidebar's right edge: drag it to resize the sidebar,
 * or most of the way shut to close it; double click for its usual width
 */
export function Resizer(props) {
  const sidebar = props.sidebar;
  function onPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebar.width();
    handle.dataset.dragging = "";
    function onMove(event) {
      const wanted = startWidth + event.clientX - startX;
      if (wanted < CLOSE_BELOW) {
        finish();
        // it comes back as wide as it was before this drag
        sidebar.setWidth(startWidth);
        sidebar.setOpen(false);
        return;
      }
      sidebar.setWidth(Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, wanted))));
    }
    function finish() {
      delete handle.dataset.dragging;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }
  return html`<div
    class="lattice-resizer"
    role="separator"
    aria-orientation="vertical"
    title="drag to resize, or to close · double click for the usual width"
    onPointerDown=${onPointerDown}
    onDblClick=${() => sidebar.setWidth(sidebar.defaultWidth)}
  ></div>`;
}
