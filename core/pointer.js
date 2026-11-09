// a pointer: an arrow in someone's colour (their contact's, the one people
// see them in), or a mouse, if they picked their colour holding alt. it's
// what's in lattice's settings' colours, your mouse's own there, and
// everyone else's over the panes (latticework's presence)

// patchwork's presence colours (the account package's palette)
export const COLOURS = [
  ["sky", "hsl(200, 70%, 50%)"],
  ["coral", "hsl(10, 75%, 58%)"],
  ["emerald", "hsl(145, 70%, 45%)"],
  ["violet", "hsl(270, 70%, 55%)"],
  ["amber", "hsl(38, 85%, 50%)"],
  ["rose", "hsl(350, 70%, 55%)"],
  ["teal", "hsl(178, 70%, 45%)"],
  ["indigo", "hsl(235, 70%, 58%)"],
  ["lime", "hsl(85, 70%, 45%)"],
  ["fuchsia", "hsl(310, 70%, 55%)"],
  ["orange", "hsl(25, 80%, 52%)"],
  ["cyan", "hsl(188, 75%, 48%)"],
];
// the colour of someone who's not picked one: one of those, from their url
export const colourFor = (url) =>
  COLOURS[[...String(url)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % COLOURS.length][1];

export const POINTER_PATH = "M4 1.6v11.6l2.9-2.7 1.9 4.4 2.1-.9-1.9-4.3h4.1z";

// a mouse, side on, facing right (in 20 × 16): her tail, her body, her ear
// (and the inside of it), her eye, her nose
export const MOUSE = {
  tail: "M4.4 12.2c-2.6.2-3.8-1.6-3-3.6.5-1.2 1.8-1.4 2.4-.7",
  body: "M3.9 12.6c-.3-3.7 2.6-6.2 6.4-6.1 2.7.1 4.6 1.6 7 3.5.6.5.4 1.3-.3 1.5-1.6.5-3.3 1.1-5.4 1.2H5.1c-.6 0-1.1-.1-1.2-.1z",
  ear: [11.6, 6.3, 2.5],
  inner: [11.6, 6.3, 1.25],
  eye: [14.5, 9.1, 0.75],
  nose: [17.5, 10.6, 0.65],
};
// the very end of her nose
const NOSE_TIP = [18.15, 10.6];

const circle = ([cx, cy, r], rest = "") => `<circle cx="${cx}" cy="${cy}" r="${r}" ${rest}/>`;
const usable = (colour) => {
  colour = String(colour ?? "").trim();
  return colour && !/["<>]/.test(colour) ? colour : null;
};

// the arrow, drawn this big: its tip's at the hotspot (the path's 4,1.6 of 16)
const ARROW_SIZE = 22;
function arrow(colour) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ARROW_SIZE}" height="${ARROW_SIZE}" viewBox="0 0 16 16"><path d="${POINTER_PATH}" fill="${colour}" stroke="white" stroke-width="1.2" stroke-linejoin="round" paint-order="stroke"/></svg>`;
  return { svg, size: ARROW_SIZE, x: Math.round((4 * ARROW_SIZE) / 16), y: Math.round((1.6 * ARROW_SIZE) / 16) };
}

// the mouse, turned so her nose is where an arrow's tip would be: facing up
// and to the left, her nose on the hotspot. a white edge round all of her,
// so she shows on anything
const MOUSE_SIZE = 24;
const MOUSE_SCALE = 1.4;
const MOUSE_AT = [2, 3];
function mouse(colour) {
  const turn = `translate(${MOUSE_AT.join(" ")}) scale(${MOUSE_SCALE}) rotate(45) scale(-1 1) translate(${-NOSE_TIP[0]} ${-NOSE_TIP[1]})`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${MOUSE_SIZE}" height="${MOUSE_SIZE}" viewBox="0 0 ${MOUSE_SIZE} ${MOUSE_SIZE}"><g transform="${turn}">
<g fill="white" stroke="white" stroke-linejoin="round" stroke-linecap="round">
<path d="${MOUSE.tail}" fill="none" stroke-width="2.4"/><path d="${MOUSE.body}" stroke-width="1.6"/>${circle(MOUSE.ear, 'stroke-width="1.6"')}${circle(MOUSE.nose, 'stroke-width="1.2"')}
</g>
<path d="${MOUSE.tail}" fill="none" stroke="${colour}" stroke-width="1.2" stroke-linecap="round"/>
<path d="${MOUSE.body}" fill="${colour}"/>${circle(MOUSE.ear, `fill="${colour}"`)}${circle(MOUSE.inner, 'fill="white" fill-opacity="0.55"')}${circle(MOUSE.eye, 'fill="#1c1a17"')}${circle(MOUSE.nose, 'fill="#f08bb4"')}
</g></svg>`;
  return { svg, size: MOUSE_SIZE, x: MOUSE_AT[0], y: MOUSE_AT[1] };
}

/**
 * a pointer in `colour` ("arrow" or "mouse"), drawn: {src, size, x, y}, an
 * image `size` px square, its point (the arrow's tip, her nose) at x, y.
 * or null, for no colour
 */
export function pointerImage(colour, kind = "arrow") {
  colour = usable(colour);
  if (!colour) return null;
  const { svg, ...rest } = kind === "mouse" ? mouse(colour) : arrow(colour);
  return { src: `data:image/svg+xml,${encodeURIComponent(svg)}`, ...rest };
}

/** a css cursor of your pointer in `colour` ("arrow" or "mouse"), or null */
export function pointerCursor(colour, kind = "arrow") {
  const image = pointerImage(colour, kind);
  return image && `url("${image.src}") ${image.x} ${image.y}, auto`;
}
