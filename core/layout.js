// a layout, kept on a project as flat nodes, each pointing at its parent:
//
//   nodes: {
//     [id]: {
//       parent,          // a node id, or null at the top
//       order,           // a fractional index among its siblings
//       type,            // "split" | "group" | "panel"
//       direction,       // splits: "row" | "column"
//       size,            // splits and groups: {flex: n} | {px: n}
//       min, max,        // px, optional
//       url, tool,       // panels: the doc, and the tool showing it
//       patchworkTool,   // panels with tool "patchwork": which of patchwork's
//                        // tools, when it isn't the one patchwork would pick
//       float,           // {x, y, w, h, z}: a group or split floating free
//     },
//   }
//
// panels sit in groups (as tabs), groups and splits in splits. the one node
// with no parent and no float is the tiled root. which tab is showing isn't
// kept here.
//
// every edit changes only the nodes it has to, so it can run on a doc inside
// handle.change (`nodes` is doc.nodes) or on a plain object. edits repair the
// nodes first and tidy up after, so they always start from a tree

export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function newId() {
  return crypto.randomUUID().slice(0, 8);
}

// ── fractional indexes ──────────────────────────────────────────────────────
// a key is a string of DIGITS read as a fraction (0.xyz), never ending in the
// lowest digit, so there's always room before it. keys sort as strings

export function isKey(key) {
  if (typeof key !== "string" || !key.length || key.endsWith(DIGITS[0])) return false;
  for (const char of key) if (!DIGITS.includes(char)) return false;
  return true;
}

// a key between a and b (either may be null, for the start or the end)
export function between(a, b) {
  a ??= "";
  if (b != null && a >= b) throw new RangeError(`between: ${a} isn't before ${b}`);
  return midpoint(a, b ?? null);
}

function midpoint(a, b) {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? DIGITS[0]) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ── specs: nested trees to add from ─────────────────────────────────────────
// the shapes read() returns, ids optional. the old stored tree shape (a
// split's `sizes` as percentages, a group's `active`) is read too

export function newPanel(url, tool, patchworkTool) {
  return patchworkTool ? { type: "panel", url, tool, patchworkTool } : { type: "panel", url, tool };
}

export function newGroup(panels) {
  return { type: "group", panels };
}

export function newSplit(direction, children, sizes) {
  return {
    type: "split",
    direction,
    children: sizes
      ? children.map((child, index) => ({ ...child, size: { flex: sizes[index] } }))
      : children,
  };
}

// ── reading ─────────────────────────────────────────────────────────────────

// the layout as a tree: {root, floats}. root is the tiled part (or null), and
// floats are the floating ones, lowest first. what a merge can leave behind
// is repaired in what's returned; repair() writes the same fixes to the doc
//
//   split: {id, type, direction, size, min?, max?, float?, children}
//   group: {id, type, size, min?, max?, float?, panels}
//   panel: {id, type, url, tool, patchworkTool?}
export function read(nodes) {
  const copy = nodes ? JSON.parse(JSON.stringify(nodes)) : {};
  repair(copy);
  const children = childrenOf(copy);
  const build = (id) => {
    const node = copy[id];
    const out = { id, type: node.type };
    if (node.type === "panel") {
      out.url = node.url;
      out.tool = node.tool;
      if (node.patchworkTool) out.patchworkTool = node.patchworkTool;
      return out;
    }
    if (node.type === "split") out.direction = node.direction;
    out.size = node.size;
    if (node.min != null) out.min = node.min;
    if (node.max != null) out.max = node.max;
    if (node.float) out.float = node.float;
    out[node.type === "group" ? "panels" : "children"] = (children.get(id) ?? []).map(build);
    return out;
  };
  const top = children.get(null) ?? [];
  const root = top.find((id) => !copy[id].float);
  const floats = top
    .filter((id) => copy[id].float)
    .sort((a, b) => copy[a].float.z - copy[b].float.z || compare(a, b));
  return { root: root ? build(root) : null, floats: floats.map(build) };
}

// the first panel showing `url`, in the order they're laid out: its id
export function findPanelShowing(nodes, url) {
  const { root, floats } = read(nodes);
  for (const panel of panelsIn([root, ...floats])) if (panel.url === url) return panel.id;
  return null;
}

function* panelsIn(trees) {
  for (const tree of trees) {
    if (!tree) continue;
    if (tree.type === "panel") yield tree;
    else yield* panelsIn(tree.panels ?? tree.children);
  }
}

// parent id (or null) → its children's ids, in order
function childrenOf(nodes) {
  const children = new Map();
  for (const id of Object.keys(nodes)) {
    const parent = nodes[id].parent ?? null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(id);
  }
  for (const list of children.values()) {
    list.sort((a, b) => {
      const ka = nodes[a].order;
      const kb = nodes[b].order;
      // keys that aren't keys go last
      const va = isKey(ka);
      const vb = isKey(kb);
      if (va !== vb) return va ? -1 : 1;
      return (va ? compare(ka, kb) : 0) || compare(a, b);
    });
  }
  return children;
}

// the groups and splits at the top that aren't floating
function tops(nodes) {
  return (childrenOf(nodes).get(null) ?? []).filter((id) => nodes[id].type !== "panel" && !nodes[id].float);
}

// ── writing only what's different ───────────────────────────────────────────

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => same(a[key], b[key]));
}

// a fresh copy: a doc won't take an object that's already in it
const fresh = (value) => (value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value);

// set a field, or delete it (undefined, or null for anything but parent), if
// that's different. true if it was
function put(node, key, value) {
  if (value === undefined || (value === null && key !== "parent")) {
    if (!(key in node)) return false;
    delete node[key];
    return true;
  }
  if (same(node[key], value)) return false;
  node[key] = fresh(value);
  return true;
}

// ── repairs ─────────────────────────────────────────────────────────────────
// what concurrent edits can leave: a node whose parent was deleted, a loop of
// parents, two roots, empty groups and splits, a split of one, the same order
// twice. the fixes depend only on what's in the nodes, so two people
// repairing the same nodes write the same things (a node a repair makes has
// an id made from the node it's for). returns whether anything changed

export function repair(nodes) {
  let changed = false;
  const mark = (did) => {
    if (did) changed = true;
    return did;
  };
  const ids = () => Object.keys(nodes).sort();
  const isGroup = (id) => nodes[id]?.type === "group";
  const isSplit = (id) => nodes[id]?.type === "split";

  // things that aren't nodes
  for (const id of ids()) {
    const node = nodes[id];
    const ok =
      node &&
      typeof node === "object" &&
      (node.type === "split" || node.type === "group" || (node.type === "panel" && typeof node.url === "string"));
    if (!ok) mark(delete nodes[id]);
  }

  // groups and splits sit in splits or at the top, and only they float
  for (const id of ids()) {
    const node = nodes[id];
    if (node.parent === undefined) mark(put(node, "parent", null));
    if (node.type === "panel") {
      mark(put(node, "float", undefined));
      continue;
    }
    if (node.parent !== null && (node.parent === id || !isSplit(node.parent))) mark(put(node, "parent", null));
    if (node.float !== undefined) {
      const float = node.float;
      const ok = float && ["x", "y", "w", "h"].every((key) => Number.isFinite(float[key]));
      if (node.parent !== null || !ok) mark(put(node, "float", undefined));
      else if (!Number.isFinite(float.z)) mark(put(node, "float", { ...fresh(float), z: 0 }));
    }
  }

  // a loop of splits: the one with the lowest id goes to the top
  for (const id of ids()) {
    const path = [];
    let at = id;
    while (at !== null && nodes[at].type !== "panel") {
      const seen = path.indexOf(at);
      if (seen !== -1) {
        const loop = path.slice(seen).sort();
        mark(put(nodes[loop[0]], "parent", null));
        break;
      }
      path.push(at);
      at = nodes[at].parent;
    }
  }

  // sizes and directions
  for (const id of ids()) {
    const node = nodes[id];
    if (node.type === "panel") continue;
    const size = node.size;
    const ok =
      size &&
      typeof size === "object" &&
      Object.keys(size).length === 1 &&
      ((Number.isFinite(size.flex) && size.flex > 0) || (Number.isFinite(size.px) && size.px >= 0));
    if (!ok) mark(put(node, "size", { flex: 1 }));
    if (node.type === "split" && node.direction !== "row" && node.direction !== "column") {
      mark(put(node, "direction", "row"));
    }
  }

  mark(repairOrders(nodes));

  // one root: a split rather than a group, then the first. the rest go in it
  // at the end. if they're all groups, their panels go in the first one
  const top = tops(nodes);
  if (top.length > 1) {
    const root = top.find(isSplit) ?? top[0];
    for (const id of top) {
      if (id === root) continue;
      if (isSplit(root)) mark(append(nodes, id, root));
      else {
        for (const panel of childrenOf(nodes).get(id) ?? []) mark(append(nodes, panel, root));
        mark(delete nodes[id]);
      }
    }
  }

  // panels outside a group go in the first group there is, or one made for them
  const strays = ids().filter((id) => nodes[id].type === "panel" && !isGroup(nodes[id].parent));
  if (strays.length) {
    let home = firstGroup(nodes);
    if (!home) {
      home = `${strays[0]}g`;
      nodes[home] = { type: "group", parent: null, order: between(lastKey(nodes, null), null), size: { flex: 1 } };
    }
    for (const id of strays) mark(append(nodes, id, home));
  }

  // tidy, until there's nothing left to: empty groups and splits go, a split
  // of one is replaced by what's in it, and a split in a split going the
  // same way is opened out into it
  for (let again = true; again; ) {
    again = false;
    const children = childrenOf(nodes);
    for (const id of ids()) {
      const node = nodes[id];
      if (node.type === "panel") continue;
      const kids = children.get(id) ?? [];
      if (!kids.length) {
        delete nodes[id];
        again = true;
      } else if (node.type === "split" && kids.length === 1) {
        const only = nodes[kids[0]];
        for (const key of ["parent", "order", "size", "min", "max", "float"]) put(only, key, node[key]);
        delete nodes[id];
        again = true;
      } else if (node.type === "split" && node.parent !== null && node.size.flex) {
        if (nodes[node.parent].direction !== node.direction) continue;
        const siblings = children.get(node.parent);
        const at = siblings.indexOf(id);
        const end = siblings[at + 1] ? nodes[siblings[at + 1]].order : null;
        let key = siblings[at - 1] ? nodes[siblings[at - 1]].order : null;
        const total = kids.reduce((sum, kid) => sum + (nodes[kid].size.flex ?? 0), 0) || 1;
        for (const kid of kids) {
          key = between(key, end);
          put(nodes[kid], "parent", node.parent);
          put(nodes[kid], "order", key);
          const flex = nodes[kid].size.flex;
          if (flex) put(nodes[kid], "size", { flex: (flex / total) * node.size.flex });
        }
        delete nodes[id];
        again = true;
      }
      if (again) {
        changed = true;
        break;
      }
    }
  }

  return changed;
}

// make every set of siblings' keys real and different. where one isn't, or
// isn't after the one before, it gets one between its neighbours
function repairOrders(nodes) {
  let changed = false;
  for (const list of childrenOf(nodes).values()) {
    let previous = null;
    list.forEach((id, index) => {
      const key = nodes[id].order;
      if (isKey(key) && (previous === null || key > previous)) {
        previous = key;
        return;
      }
      let next = null;
      for (const later of list.slice(index + 1)) {
        const laterKey = nodes[later].order;
        if (isKey(laterKey) && (previous === null || laterKey > previous)) {
          next = laterKey;
          break;
        }
      }
      previous = between(previous, next);
      nodes[id].order = previous;
      changed = true;
    });
  }
  return changed;
}

function lastKey(nodes, parent) {
  const list = childrenOf(nodes).get(parent) ?? [];
  return list.length ? nodes[list.at(-1)].order : null;
}

// put a node last in `parent`
function append(nodes, id, parent) {
  if (nodes[id].parent === parent) return false;
  const key = between(lastKey(nodes, parent), null);
  put(nodes[id], "parent", parent);
  put(nodes[id], "order", key);
  return true;
}

// the first group, tiled ones before floating ones
function firstGroup(nodes) {
  const children = childrenOf(nodes);
  const top = (children.get(null) ?? []).filter((id) => nodes[id].type !== "panel");
  const roots = [...top.filter((id) => !nodes[id].float), ...top.filter((id) => nodes[id].float)];
  const walk = (id) => {
    if (nodes[id].type === "group") return id;
    for (const child of children.get(id) ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  for (const id of roots) {
    const found = walk(id);
    if (found) return found;
  }
  return null;
}

// ── adding ──────────────────────────────────────────────────────────────────

// write a spec (a nested tree) into the nodes, under `parent` at `order`.
// returns the ids it made: the spec's own as `root`, and all of them by type
function add(nodes, spec, parent, order, made = { root: null, panels: [], groups: [], splits: [] }) {
  const id = spec.id && !nodes[spec.id] ? spec.id : newId();
  made.root ??= id;
  const type = spec.type ?? "panel";
  const node = { type, parent, order };
  if (type === "panel") {
    node.url = spec.url;
    node.tool = spec.tool;
    if (spec.patchworkTool) node.patchworkTool = spec.patchworkTool;
    nodes[id] = node;
    made.panels.push(id);
    return made;
  }
  node.size = fresh(spec.size) ?? { flex: 1 };
  if (type === "split") node.direction = spec.direction;
  if (spec.min != null) node.min = spec.min;
  if (spec.max != null) node.max = spec.max;
  if (spec.float) node.float = fresh(spec.float);
  nodes[id] = node;
  made[type === "split" ? "splits" : "groups"].push(id);
  // the old shape: a split's sizes are percentages, one per child
  const kids = (type === "split" ? spec.children : spec.panels) ?? [];
  let key = null;
  kids.forEach((kid, index) => {
    key = between(key, null);
    const size = spec.sizes?.[index];
    add(nodes, size != null && !kid.size ? { ...kid, size: { flex: size } } : kid, id, key, made);
  });
  return made;
}

// add a spec at the top, after everything there
const addAtTop = (nodes, spec) => add(nodes, spec, null, between(lastKey(nodes, null), null));

// an old stored tree as nodes, keeping its ids. `active` is which panel each
// group had showing, for whatever keeps that now
export function fromTree(tree) {
  const nodes = {};
  const active = {};
  if (tree) {
    addAtTop(nodes, tree);
    const walk = (node) => {
      if (node?.type === "group" && node.active && nodes[node.active]) active[node.id] = node.active;
      for (const kid of node?.children ?? []) walk(kid);
    };
    walk(tree);
    repair(nodes);
  }
  return { nodes, active };
}

// ── edits ───────────────────────────────────────────────────────────────────
// zones are "center" (as tabs, or onto a group) or an edge: "left", "right",
// "top", "bottom"

function edit(nodes, change) {
  repair(nodes);
  const result = change();
  repair(nodes);
  return result;
}

// a panel stands for its group
function groupOrNode(nodes, id) {
  return nodes[id]?.type === "panel" ? nodes[id].parent : id;
}

// the average flex of a split's flexible children, so a newcomer gets an
// even share without anyone else's size changing
function evenShare(nodes, parent) {
  const flexes = (childrenOf(nodes).get(parent) ?? []).map((id) => nodes[id].size?.flex).filter(Boolean);
  return flexes.length ? flexes.reduce((sum, flex) => sum + flex, 0) / flexes.length : 1;
}

function isAncestor(nodes, ancestor, id) {
  for (let at = nodes[id]?.parent; at != null; at = nodes[at]?.parent) if (at === ancestor) return true;
  return false;
}

// put the group or split `id` beside `targetId`, from wherever it was. false
// if it can't go there
function placeBeside(nodes, id, targetId, edge) {
  const direction = edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  const node = nodes[id];
  const target = groupOrNode(nodes, targetId);
  if (!nodes[target] || target === id || isAncestor(nodes, id, target)) return false;
  put(node, "float", undefined);
  const parent = nodes[target].parent;
  if (parent !== null && nodes[parent].direction === direction) {
    if (node.parent !== parent) put(node, "size", { flex: evenShare(nodes, parent) });
    const siblings = (childrenOf(nodes).get(parent) ?? []).filter((sibling) => sibling !== id);
    const at = siblings.indexOf(target);
    const [a, b] = before ? [siblings[at - 1], target] : [target, siblings[at + 1]];
    put(node, "parent", parent);
    put(node, "order", between(a ? nodes[a].order : null, b ? nodes[b].order : null));
    return true;
  }
  // wrap the target in a split going the right way, in the target's place
  const split = newId();
  const slot = nodes[target];
  nodes[split] = { type: "split", direction, parent: slot.parent, order: slot.order, size: fresh(slot.size) };
  for (const key of ["min", "max", "float"]) {
    if (slot[key] != null) nodes[split][key] = fresh(slot[key]);
    put(slot, key, undefined);
  }
  const first = between(null, null);
  const keys = [first, between(first, null)];
  (before ? [id, target] : [target, id]).forEach((one, index) => {
    put(nodes[one], "parent", split);
    put(nodes[one], "order", keys[index]);
    put(nodes[one], "size", { flex: 1 });
  });
  return true;
}

const edgeOf = (zone) => (zone === "center" ? "right" : zone);

// open panels ([{url, tool, patchworkTool?}]) in the group `targetId`: as
// tabs, or in a new group on one of its edges. with nothing open, they're
// the whole layout. returns the new panels' ids
export function openPanels(nodes, targetId, zone, panels) {
  if (!panels.length) return [];
  panels = panels.map((panel) => ({ ...panel, type: "panel" }));
  return edit(nodes, () => {
    const [root] = tops(nodes);
    let target = groupOrNode(nodes, targetId);
    if (!nodes[target]) {
      if (!root) return addAtTop(nodes, newGroup(panels)).panels;
      target = root;
      zone = edgeOf(zone);
    }
    if (zone === "center" && nodes[target].type === "group") {
      return panels.flatMap((panel) => add(nodes, panel, target, between(lastKey(nodes, target), null)).panels);
    }
    const made = addAtTop(nodes, newGroup(panels));
    placeBeside(nodes, made.root, target, edgeOf(zone));
    return made.panels;
  });
}

// move a panel into the group `targetId` (zone "center"), or into a new group
// on one of its edges. a group's only panel moves with its group
export function movePanel(nodes, panelId, targetId, zone) {
  edit(nodes, () => {
    const panel = nodes[panelId];
    const target = groupOrNode(nodes, targetId);
    if (panel?.type !== "panel" || !nodes[target]) return;
    const from = panel.parent;
    if (zone === "center" && nodes[target].type === "group") {
      if (from !== target) append(nodes, panelId, target);
      return;
    }
    if ((childrenOf(nodes).get(from) ?? []).length === 1) {
      placeBeside(nodes, from, target, edgeOf(zone));
      return;
    }
    const order = panel.order;
    const group = addAtTop(nodes, newGroup([])).root;
    put(panel, "parent", group);
    put(panel, "order", between(null, null));
    if (!placeBeside(nodes, group, target, edgeOf(zone))) {
      put(panel, "parent", from);
      put(panel, "order", order);
      delete nodes[group];
    }
  });
}

// move a group or split (tiled or floating) onto an edge of `targetId`. onto
// the middle of a group, a group's panels join it as tabs
export function moveNode(nodes, id, targetId, zone) {
  edit(nodes, () => {
    const node = nodes[id];
    const target = groupOrNode(nodes, targetId);
    if (!node || node.type === "panel" || !nodes[target] || target === id) return;
    if (zone === "center" && node.type === "group" && nodes[target].type === "group") {
      for (const panel of childrenOf(nodes).get(id) ?? []) append(nodes, panel, target);
      return;
    }
    placeBeside(nodes, id, target, edgeOf(zone));
  });
}

// add a spec as a full-width row under everything, with an even share of
// the height. returns the new panels' ids
export function addRow(nodes, spec) {
  return edit(nodes, () => {
    const [root] = tops(nodes);
    const made = addAtTop(nodes, (spec.type ?? "panel") === "panel" ? newGroup([spec]) : spec);
    if (!root) return made.panels;
    if (nodes[root].type === "split" && nodes[root].direction === "column") {
      put(nodes[made.root], "size", { flex: evenShare(nodes, root) });
      append(nodes, made.root, root);
    } else {
      placeBeside(nodes, made.root, root, "bottom");
    }
    return made.panels;
  });
}

// close a panel, group or split (and what's in it)
export function remove(nodes, id) {
  edit(nodes, () => {
    if (!nodes[id]) return;
    const children = childrenOf(nodes);
    const gone = [id];
    for (let i = 0; i < gone.length; i++) gone.push(...(children.get(gone[i]) ?? []));
    for (const each of gone) delete nodes[each];
  });
}

export function setTool(nodes, panelId, tool, patchworkTool) {
  const panel = nodes[panelId];
  if (panel?.type !== "panel") return;
  put(panel, "tool", tool);
  put(panel, "patchworkTool", patchworkTool || undefined);
}

// sizes: {[id]: {flex: n} | {px: n}}, for the nodes either side of a divider
export function resize(nodes, sizes) {
  for (const [id, size] of Object.entries(sizes)) {
    if (nodes[id] && nodes[id].type !== "panel") put(nodes[id], "size", size);
  }
}

// float a group or split at {x, y, w, h}, over everything else, or move and
// size one that's already floating. a panel floats in a group of its own.
// returns the floating node's id
export function float(nodes, id, rect) {
  return edit(nodes, () => {
    if (!nodes[id]) return null;
    if (nodes[id].type === "panel" && (childrenOf(nodes).get(nodes[id].parent) ?? []).length === 1) {
      id = nodes[id].parent;
    } else if (nodes[id].type === "panel") {
      const panel = id;
      id = addAtTop(nodes, newGroup([])).root;
      put(nodes[panel], "parent", id);
      put(nodes[panel], "order", between(null, null));
    }
    const node = nodes[id];
    const others = Object.keys(nodes)
      .filter((other) => other !== id && nodes[other].float)
      .map((other) => nodes[other].float.z);
    const onTop = node.float && others.every((z) => z < node.float.z);
    const z = onTop ? node.float.z : Math.max(0, ...others) + 1;
    if (node.parent !== null) put(node, "order", between(lastKey(nodes, null), null));
    put(node, "parent", null);
    put(node, "float", { x: rect.x, y: rect.y, w: rect.w, h: rect.h, z });
    return id;
  });
}

// a floating panel back in the tiles: a tab in the group `targetId`, if
// that's tiled, or else in the first tiled group. with nothing tiled, it's
// the whole of the tiles (its group with it, if it was the only tab)
export function dock(nodes, panelId, targetId) {
  edit(nodes, () => {
    const panel = nodes[panelId];
    if (panel?.type !== "panel") return;
    const [root] = tops(nodes);
    const topOf = (id) => {
      while (nodes[id]?.parent != null) id = nodes[id].parent;
      return id;
    };
    if (root && topOf(panelId) === root) return;
    if (root) {
      const target = groupOrNode(nodes, targetId);
      const tiled = nodes[target]?.type === "group" && topOf(target) === root;
      append(nodes, panelId, tiled ? target : firstGroup(nodes));
      return;
    }
    const group = nodes[panel.parent];
    if (group.parent === null && (childrenOf(nodes).get(panel.parent) ?? []).length === 1) {
      put(group, "float", undefined);
      return;
    }
    const made = addAtTop(nodes, newGroup([])).root;
    put(panel, "parent", made);
    put(panel, "order", between(null, null));
  });
}
