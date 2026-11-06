const SVG = "http://www.w3.org/2000/svg";

// line drawings on a 16 unit square, in the ink they sit in
const PATHS = {
  plus: "M8 3.5v9M3.5 8h9",
  close: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  "chevron-down": "M4.5 6.25 8 9.75l3.5-3.5",
  "chevron-right": "M6.25 4.5 9.75 8l-3.5 3.5",
  warning: "M8 2.5 14 13H2ZM8 6.5v3M8 11.25v.01",
  play: "M5 3.5v9l7.5-4.5Z",
  pause: "M6 4v8M10 4v8",
  restart: "M4.5 4v8M11.5 4 7 8l4.5 4",
  back: "M10 4 6 8l4 4",
  step: "M6 4l4 4-4 4",
  "open-new":
    "M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v3.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3.5",
  // a wand, sparkling
  build: "M2.5 13.5l7-7M11.5 1.5V3M14.5 4.5H13M13.6 2.4l-1 1M13.6 6.6l-1-1M9.4 2.4l1 1",
  stop: "M4.5 4.5h7v7h-7Z",
  // a window with a pane open on its right
  beside: "M2.5 3.5h11v9h-11ZM8.5 3.5v9",
  "arrow-right": "M3 8h10M9.5 4.5 13 8l-3.5 3.5",
  copy: "M5.5 5.5h7v7h-7ZM10.5 5.5v-2h-7v7h2",
  check: "M3.5 8.5l3 3 6-7",
  rebuild: "M13 8a5 5 0 1 1-1.46-3.54M8.8 4.46h2.74V1.72",
  lock: "M4 7.5h8v6H4ZM5.5 7.5v-2a2.5 2.5 0 0 1 5 0v2",
  pencil: "M10.5 3 13 5.5 6 12.5 3 13l.5-3ZM9 4.5 11.5 7",
  file: "M4 2.5h5l3 3v8H4ZM9 2.5v3h3",
  text: "M4 2.5h5l3 3v8H4ZM9 2.5v3h3M6 8.5h4M6 10.5h3",
  terminal: "M2.5 3.5h11v9h-11ZM5 6.5 7 8l-2 1.5M8.5 10H11",
  folder:
    "M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z",
  link:
    "M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.75.75M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.75-.75",
  download: "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10",
  // four corners: everything back in view
  fit: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
  flip: "M2.5 5.5h10L10 3M13.5 10.5h-10L6 13",
  comment: "M3 3.5h10v7H7.5l-3 2.5v-2.5H3Z",
};

/**
 * a line icon, as an <svg> element: goes into html`` templates and plain dom
 * alike. `size` is anything an svg's width takes; by default it's as big as
 * the text around it, and sits on its line like a letter
 */
export function icon(name, size = "1em") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `icon icon-${name}`);
  svg.style.flex = "none";
  svg.style.verticalAlign = "-0.125em";
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", PATHS[name]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

// put an icon before a button's words
export function withIcon(name, button) {
  button.prepend(icon(name), " ");
  return button;
}
