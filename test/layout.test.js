import { test } from "node:test";
import assert from "node:assert/strict";
import * as Automerge from "@automerge/automerge";
import {
  between,
  isKey,
  read,
  repair,
  fromTree,
  newPanel,
  newGroup,
  newSplit,
  openPanels,
  movePanel,
  moveNode,
  addRow,
  remove,
  setTool,
  resize,
  float,
  dock,
  findPanelShowing,
} from "../core/layout.js";

// ── helpers ─────────────────────────────────────────────────────────────────

// the tree as a short string: row(a b | c) is a row split of a group with
// tabs a and b, and a group with c. panels are named by their urls
function shape(tree) {
  if (!tree) return "";
  if (tree.type === "panel") return tree.url;
  if (tree.type === "group") return tree.panels.map(shape).join(" ");
  return `${tree.direction}(${tree.children.map(shape).join(" | ")})`;
}
const shapeOf = (nodes) => {
  const { root, floats } = read(nodes);
  return [shape(root), ...floats.map((tree) => `float ${shape(tree)}`)].join(", ");
};

// a group's id by a url in it
const groupWith = (nodes, url) => nodes[findPanelShowing(nodes, url)].parent;

// which nodes are different between two copies
function touched(before, after) {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...ids].filter((id) => JSON.stringify(before[id]) !== JSON.stringify(after[id])).sort();
}
const clone = (value) => JSON.parse(JSON.stringify(value));

// what a read tree must be, whatever happened to the nodes
function assertTree(nodes) {
  const { root, floats } = read(nodes);
  const seen = new Set();
  const visit = (node, parentDirection) => {
    assert(!seen.has(node.id), `${node.id} is in the tree twice`);
    seen.add(node.id);
    if (node.type === "panel") return;
    if (node.type === "group") {
      assert(node.panels.length > 0, "an empty group");
      for (const panel of node.panels) {
        assert.equal(panel.type, "panel");
        visit(panel);
      }
      return;
    }
    assert(node.children.length > 1, "a split of one");
    assert.notEqual(node.direction, parentDirection, "a split in a split going the same way");
    for (const child of node.children) {
      assert.notEqual(child.type, "panel", "a panel in a split");
      visit(child, node.direction);
    }
  };
  if (root) visit(root);
  for (const tree of floats) visit(tree);
  return seen;
}

// a doc with the nodes in it
function docOf(nodes = {}) {
  return Automerge.from({ nodes });
}
const change = (doc, fn) => Automerge.change(doc, (d) => fn(d.nodes));
const nodesOf = (doc) => clone(doc.nodes);

// ── fractional indexes ──────────────────────────────────────────────────────

test("keys go between keys, and stay keys", () => {
  const a = between(null, null);
  const b = between(a, null);
  assert(a < b);
  assert(between(null, a) < a);
  // a hundred times into the same gap
  let low = a;
  for (let i = 0; i < 100; i++) {
    const key = between(low, b);
    assert(isKey(key) && low < key && key < b, `${low} < ${key} < ${b}`);
    low = key;
  }
  let high = b;
  for (let i = 0; i < 100; i++) {
    const key = between(a, high);
    assert(isKey(key) && a < key && key < high);
    high = key;
  }
  assert.throws(() => between(b, a));
});

// ── old trees ───────────────────────────────────────────────────────────────

test("an old tree comes over with its ids, sizes and active tabs", () => {
  const old = {
    id: "s1",
    type: "split",
    direction: "row",
    sizes: [25, 75],
    children: [
      { id: "g1", type: "group", active: "p2", panels: [{ id: "p1", url: "a", tool: "editor" }, { id: "p2", url: "b", tool: "editor" }] },
      {
        id: "s2",
        type: "split",
        direction: "column",
        sizes: [50, 50],
        children: [
          { id: "g2", type: "group", active: "p3", panels: [{ id: "p3", url: "c", tool: "visualizer" }] },
          { id: "g3", type: "group", active: "p4", panels: [{ id: "p4", url: "d", tool: "patchwork", patchworkTool: "markdown" }] },
        ],
      },
    ],
  };
  const { nodes, active } = fromTree(old);
  assert.equal(shapeOf(nodes), "row(a b | column(c | d))");
  assert.deepEqual(active, { g1: "p2", g2: "p3", g3: "p4" });
  assert.deepEqual(nodes.g1.size, { flex: 25 });
  assert.deepEqual(nodes.s2.size, { flex: 75 });
  assert.equal(nodes.p4.patchworkTool, "markdown");
  assert.equal(nodes.p1.parent, "g1");
  assert.equal(read(nodes).root.id, "s1");
});

test("the specs knitoutjs makes a new project from", () => {
  const { nodes } = fromTree(
    newSplit("row", [newGroup([newPanel("js", "editor")]), newGroup([newPanel("k", "editor")]), newGroup([newPanel("k", "visualizer")])]),
  );
  assert.equal(shapeOf(nodes), "row(js | k | k)");
  assert.equal(fromTree(null).nodes && Object.keys(fromTree(null).nodes).length, 0);
});

// ── edits ───────────────────────────────────────────────────────────────────

test("opening into nothing makes the layout", () => {
  const nodes = {};
  const [id] = openPanels(nodes, null, "center", [{ url: "a", tool: "editor" }]);
  assert.equal(shapeOf(nodes), "a");
  assert.equal(nodes[id].url, "a");
});

test("opening as tabs, and beside", () => {
  const nodes = {};
  openPanels(nodes, null, "center", [{ url: "a", tool: "editor" }]);
  openPanels(nodes, groupWith(nodes, "a"), "center", [{ url: "b", tool: "editor" }]);
  assert.equal(shapeOf(nodes), "a b");
  openPanels(nodes, groupWith(nodes, "a"), "right", [{ url: "c", tool: "editor" }]);
  assert.equal(shapeOf(nodes), "row(a b | c)");
  openPanels(nodes, groupWith(nodes, "a"), "left", [{ url: "d", tool: "editor" }]);
  assert.equal(shapeOf(nodes), "row(d | a b | c)");
  openPanels(nodes, groupWith(nodes, "c"), "bottom", [{ url: "e", tool: "editor" }]);
  assert.equal(shapeOf(nodes), "row(d | a b | column(c | e))");
  openPanels(nodes, groupWith(nodes, "c"), "top", [{ url: "f", tool: "editor" }]);
  assert.equal(shapeOf(nodes), "row(d | a b | column(f | c | e))");
  // a target that's gone: beside everything
  openPanels(nodes, "nope", "center", [{ url: "g", tool: "editor" }]);
  assert.equal(shapeOf(nodes), "row(d | a b | column(f | c | e) | g)");
  assertTree(nodes);
});

test("a new pane in a row touches only itself", () => {
  const { nodes } = fromTree(newSplit("row", [newGroup([newPanel("a", "editor")]), newGroup([newPanel("b", "editor")])], [30, 70]));
  const before = clone(nodes);
  const [id] = openPanels(nodes, groupWith(nodes, "b"), "right", [{ url: "c", tool: "editor" }]);
  const group = nodes[id].parent;
  assert.deepEqual(touched(before, nodes), [group, id].sort());
  // an even share, without anyone else's changing
  assert.deepEqual(nodes[group].size, { flex: 50 });
});

test("moving a tab touches only the tab", () => {
  const nodes = {};
  openPanels(nodes, null, "center", [{ url: "a", tool: "editor" }, { url: "b", tool: "editor" }]);
  openPanels(nodes, groupWith(nodes, "a"), "right", [{ url: "c", tool: "editor" }]);
  const before = clone(nodes);
  const b = findPanelShowing(nodes, "b");
  movePanel(nodes, b, groupWith(nodes, "c"), "center");
  assert.equal(shapeOf(nodes), "row(a | c b)");
  assert.deepEqual(touched(before, nodes), [b]);
});

test("moving a group's only tab moves the group, and what's left closes up", () => {
  const nodes = {};
  openPanels(nodes, null, "center", [{ url: "a", tool: "editor" }]);
  openPanels(nodes, groupWith(nodes, "a"), "right", [{ url: "b", tool: "editor" }]);
  openPanels(nodes, groupWith(nodes, "b"), "bottom", [{ url: "c", tool: "editor" }]);
  assert.equal(shapeOf(nodes), "row(a | column(b | c))");
  const groupC = groupWith(nodes, "c");
  movePanel(nodes, findPanelShowing(nodes, "c"), groupWith(nodes, "a"), "left");
  assert.equal(shapeOf(nodes), "row(c | a | b)");
  assert.equal(groupWith(nodes, "c"), groupC);
  // onto another group's middle: it joins as a tab, and its group goes
  movePanel(nodes, findPanelShowing(nodes, "c"), groupWith(nodes, "b"), "center");
  assert.equal(shapeOf(nodes), "row(a | b c)");
  assert(!nodes[groupC]);
  // beside its own group, alone in it: nothing to do
  const before = clone(nodes);
  movePanel(nodes, findPanelShowing(nodes, "a"), groupWith(nodes, "a"), "right");
  assert.deepEqual(nodes, before);
  // out of a group of two, beside that group
  movePanel(nodes, findPanelShowing(nodes, "c"), groupWith(nodes, "b"), "bottom");
  assert.equal(shapeOf(nodes), "row(a | column(b | c))");
  assertTree(nodes);
});

test("closing", () => {
  const nodes = {};
  openPanels(nodes, null, "center", [{ url: "a", tool: "editor" }, { url: "b", tool: "editor" }]);
  openPanels(nodes, groupWith(nodes, "a"), "right", [{ url: "c", tool: "editor" }]);
  remove(nodes, findPanelShowing(nodes, "c"));
  assert.equal(shapeOf(nodes), "a b");
  remove(nodes, groupWith(nodes, "a"));
  assert.equal(shapeOf(nodes), "");
  assert.deepEqual(nodes, {});
});

test("adding a row", () => {
  const nodes = {};
  addRow(nodes, newSplit("row", [newGroup([newPanel("js", "editor")]), newGroup([newPanel("k", "visualizer")])]));
  assert.equal(shapeOf(nodes), "row(js | k)");
  addRow(nodes, newSplit("row", [newGroup([newPanel("js2", "editor")]), newGroup([newPanel("k2", "visualizer")])]));
  assert.equal(shapeOf(nodes), "column(row(js | k) | row(js2 | k2))");
  addRow(nodes, newPanel("x", "editor"));
  assert.equal(shapeOf(nodes), "column(row(js | k) | row(js2 | k2) | x)");
  assertTree(nodes);
});

test("tools and sizes", () => {
  const nodes = {};
  const [a] = openPanels(nodes, null, "center", [{ url: "a", tool: "editor" }]);
  setTool(nodes, a, "patchwork", "markdown");
  assert.equal(nodes[a].patchworkTool, "markdown");
  setTool(nodes, a, "visualizer");
  assert.equal(nodes[a].tool, "visualizer");
  assert(!("patchworkTool" in nodes[a]));
  openPanels(nodes, nodes[a].parent, "right", [{ url: "b", tool: "editor" }]);
  const ga = groupWith(nodes, "a");
  const gb = groupWith(nodes, "b");
  resize(nodes, { [ga]: { px: 300 }, [gb]: { flex: 1 } });
  assert.deepEqual(read(nodes).root.children.map((child) => child.size), [{ px: 300 }, { flex: 1 }]);
});

test("floating, and docking again", () => {
  const nodes = {};
  openPanels(nodes, null, "center", [{ url: "a", tool: "editor" }, { url: "b", tool: "editor" }]);
  openPanels(nodes, groupWith(nodes, "a"), "right", [{ url: "c", tool: "editor" }]);
  // a tab floats in a group of its own
  const floating = float(nodes, findPanelShowing(nodes, "b"), { x: 10, y: 10, w: 200, h: 100 });
  assert.equal(shapeOf(nodes), "row(a | c), float b");
  // a group floats as it is, above the one before
  float(nodes, groupWith(nodes, "c"), { x: 50, y: 50, w: 200, h: 100 });
  assert.equal(shapeOf(nodes), "a, float b, float c");
  assert(nodes[groupWith(nodes, "c")].float.z > nodes[floating].float.z);
  // raising the lower one
  float(nodes, floating, { x: 20, y: 20, w: 200, h: 100 });
  assert.equal(shapeOf(nodes), "a, float c, float b");
  // docking
  moveNode(nodes, floating, groupWith(nodes, "a"), "left");
  assert.equal(shapeOf(nodes), "row(b | a), float c");
  assert(!nodes[floating].float);
  moveNode(nodes, groupWith(nodes, "c"), groupWith(nodes, "a"), "center");
  assert.equal(shapeOf(nodes), "row(b | a c)");
  assertTree(nodes);
});

test("docking a floating tab", () => {
  const nodes = {};
  openPanels(nodes, null, "center", [{ url: "a", tool: "editor" }]);
  openPanels(nodes, groupWith(nodes, "a"), "right", [{ url: "b", tool: "editor" }]);
  const b = findPanelShowing(nodes, "b");
  float(nodes, b, { x: 0, y: 0, w: 100, h: 100 });
  openPanels(nodes, groupWith(nodes, "b"), "center", [{ url: "c", tool: "editor" }]);
  assert.equal(shapeOf(nodes), "a, float b c");
  // into the group asked for, or the first tiled one
  dock(nodes, b, groupWith(nodes, "a"));
  assert.equal(shapeOf(nodes), "a b, float c");
  const c = findPanelShowing(nodes, "c");
  dock(nodes, c, "nowhere");
  assert.equal(shapeOf(nodes), "a b c");
  // a tiled tab stays where it is
  const before = clone(nodes);
  dock(nodes, b, groupWith(nodes, "a"));
  assert.deepEqual(touched(before, nodes), []);
  // with nothing tiled, a float's only tab takes its group down with it
  const floating = float(nodes, groupWith(nodes, "a"), { x: 0, y: 0, w: 100, h: 100 });
  assert.equal(shapeOf(nodes), ", float a b c");
  movePanel(nodes, c, floating, "right");
  dock(nodes, c);
  assert.equal(shapeOf(nodes), "c, float a b");
  remove(nodes, c);
  const lone = float(nodes, b, { x: 0, y: 0, w: 100, h: 100 });
  remove(nodes, findPanelShowing(nodes, "a"));
  assert.equal(shapeOf(nodes), ", float b");
  dock(nodes, b);
  assert.equal(shapeOf(nodes), "b");
  assert.equal(nodes[b].parent, lone);
  assertTree(nodes);
});

test("a floating split, and things dropped beside a float", () => {
  const nodes = {};
  openPanels(nodes, null, "center", [{ url: "a", tool: "editor" }]);
  openPanels(nodes, groupWith(nodes, "a"), "right", [{ url: "b", tool: "editor" }]);
  openPanels(nodes, groupWith(nodes, "b"), "bottom", [{ url: "c", tool: "editor" }]);
  const split = nodes[groupWith(nodes, "b")].parent;
  float(nodes, split, { x: 0, y: 0, w: 100, h: 100 });
  assert.equal(shapeOf(nodes), "a, float column(b | c)");
  openPanels(nodes, groupWith(nodes, "c"), "right", [{ url: "d", tool: "editor" }]);
  assert.equal(shapeOf(nodes), "a, float column(b | row(c | d))");
  // a group floating on its own, with something put beside it, floats as a split
  const ga = float(nodes, groupWith(nodes, "a"), { x: 5, y: 5, w: 50, h: 50 });
  openPanels(nodes, ga, "right", [{ url: "e", tool: "editor" }]);
  const { floats } = read(nodes);
  const shapes = floats.map(shape).sort();
  assert.deepEqual(shapes, ["column(b | row(c | d))", "row(a | e)"]);
  assert(floats.every((tree) => tree.float));
  assertTree(nodes);
});

// ── repairs ─────────────────────────────────────────────────────────────────

test("repairs: junk, orphans, loops, two roots, duplicate orders", () => {
  const nodes = {
    junk: 4,
    nourl: { type: "panel", parent: "g1", order: "V" },
    g1: { type: "group", parent: "s1", order: "V", size: { flex: 1 } },
    p1: { type: "panel", parent: "g1", order: "V", url: "a", tool: "editor" },
    p2: { type: "panel", parent: "g1", order: "V", url: "b", tool: "editor" },
    // a panel whose group was deleted
    p3: { type: "panel", parent: "gone", order: "V", url: "c", tool: "editor" },
    // a loop of splits, with a group in each
    s1: { type: "split", direction: "row", parent: "s2", order: "V", size: { flex: 1 } },
    s2: { type: "split", direction: "column", parent: "s1", order: "k", size: { flex: 1 } },
    g2: { type: "group", parent: "s2", order: "V", size: { flex: 1 } },
    p4: { type: "panel", parent: "g2", order: "V", url: "d", tool: "editor" },
    // a second root
    g3: { type: "group", parent: null, order: "V", size: { flex: 1 } },
    p5: { type: "panel", parent: "g3", order: "V", url: "e", tool: "editor" },
    // nonsense
    g4: { type: "group", parent: "p1", order: 7, size: "big" },
    p6: { type: "panel", parent: "g4", url: "f", tool: "editor", float: { x: 1 } },
  };
  assert(repair(nodes));
  const seen = assertTree(nodes);
  for (const id of ["p1", "p2", "p3", "p4", "p5", "p6"]) assert(seen.has(id), `${id} is lost`);
  assert(!nodes.junk && !nodes.nourl);
  // the loop: s1 goes to the top (the lower id), s2 is left with one group, so that group takes its place
  assert.equal(shapeOf(nodes), "row(a b c | d | e | f)");
  // and it's done: nothing more to repair
  assert(!repair(nodes));
});

test("two roots that are both groups become one", () => {
  const nodes = {
    g1: { type: "group", parent: null, order: "V", size: { flex: 1 } },
    p1: { type: "panel", parent: "g1", order: "V", url: "a", tool: "editor" },
    g2: { type: "group", parent: null, order: "k", size: { flex: 1 } },
    p2: { type: "panel", parent: "g2", order: "V", url: "b", tool: "editor" },
  };
  repair(nodes);
  assert.equal(shapeOf(nodes), "a b");
  assert(!nodes.g2);
});

test("reading doesn't change what it's given", () => {
  const nodes = { g1: { type: "group", parent: null, order: "V", size: { flex: 1 } } };
  const before = clone(nodes);
  assert.equal(read(nodes).root, null);
  assert.deepEqual(nodes, before);
});

// ── in a doc, and merging ───────────────────────────────────────────────────

function base() {
  let doc = docOf();
  doc = change(doc, (nodes) => {
    openPanels(nodes, null, "center", [{ url: "a", tool: "editor" }]);
    openPanels(nodes, groupWith(nodes, "a"), "right", [{ url: "b", tool: "editor" }]);
    openPanels(nodes, groupWith(nodes, "b"), "right", [{ url: "c", tool: "editor" }]);
  });
  return doc;
}
const fork = (doc) => Automerge.clone(doc);

test("edits work on a doc", () => {
  let doc = base();
  assert.equal(shapeOf(doc.nodes), "row(a | b | c)");
  doc = change(doc, (nodes) => {
    movePanel(nodes, findPanelShowing(nodes, "c"), groupWith(nodes, "a"), "bottom");
    setTool(nodes, findPanelShowing(nodes, "a"), "patchwork", "markdown");
    resize(nodes, { [groupWith(nodes, "b")]: { px: 200 } });
    float(nodes, findPanelShowing(nodes, "b"), { x: 0, y: 0, w: 10, h: 10 });
    addRow(nodes, newPanel("d", "editor"));
    remove(nodes, findPanelShowing(nodes, "d"));
  });
  assert.equal(shapeOf(doc.nodes), "column(a | c), float b");
  // a repair with nothing to repair writes nothing
  const heads = Automerge.getHeads(doc);
  doc = change(doc, (nodes) => repair(nodes));
  assert.deepEqual(Automerge.getHeads(doc), heads);
});

test("moving a pane two places at once: it ends up in one of them", () => {
  const doc = base();
  const a = change(fork(doc), (nodes) => movePanel(nodes, findPanelShowing(nodes, "c"), groupWith(nodes, "a"), "center"));
  const b = change(fork(doc), (nodes) => movePanel(nodes, findPanelShowing(nodes, "c"), groupWith(nodes, "b"), "center"));
  const merged = Automerge.merge(fork(a), b);
  const result = shapeOf(merged.nodes);
  assert(["row(a c | b)", "row(a | b c)"].includes(result), result);
});

test("an edit to a pane survives someone moving it", () => {
  const doc = base();
  const c = findPanelShowing(doc.nodes, "c");
  const a = change(fork(doc), (nodes) => movePanel(nodes, c, groupWith(nodes, "a"), "center"));
  const b = change(fork(doc), (nodes) => setTool(nodes, c, "visualizer"));
  const merged = Automerge.merge(fork(a), b);
  assert.equal(shapeOf(merged.nodes), "row(a c | b)");
  assert.equal(merged.nodes[c].tool, "visualizer");
});

test("two people opening the first pane at once", () => {
  const doc = docOf();
  const a = change(fork(doc), (nodes) => openPanels(nodes, null, "center", [{ url: "a", tool: "editor" }]));
  const b = change(fork(doc), (nodes) => openPanels(nodes, null, "center", [{ url: "b", tool: "editor" }]));
  const merged = Automerge.merge(fork(a), b);
  assert(["a b", "b a"].includes(shapeOf(merged.nodes)));
});

test("closing a group while someone moves a pane into it", () => {
  const doc = base();
  const groupA = groupWith(doc.nodes, "a");
  const a = change(fork(doc), (nodes) => remove(nodes, groupA));
  const b = change(fork(doc), (nodes) => movePanel(nodes, findPanelShowing(nodes, "c"), groupA, "center"));
  const merged = Automerge.merge(fork(a), b);
  // the pane that was moved in isn't lost
  assert.equal(shapeOf(merged.nodes), "b c");
});

test("two people splitting the same pane at once", () => {
  const doc = base();
  const a = change(fork(doc), (nodes) => openPanels(nodes, groupWith(nodes, "b"), "bottom", [{ url: "x", tool: "editor" }]));
  const b = change(fork(doc), (nodes) => openPanels(nodes, groupWith(nodes, "b"), "top", [{ url: "y", tool: "editor" }]));
  const merged = Automerge.merge(fork(a), b);
  const seen = assertTree(merged.nodes);
  for (const url of ["a", "b", "c", "x", "y"]) assert(findPanelShowing(merged.nodes, url), `${url} is lost`);
  assert.equal(seen.size, [...seen].length);
});

test("moving two splits into each other at once", () => {
  let doc = docOf();
  doc = change(doc, (nodes) => {
    openPanels(nodes, null, "center", [{ url: "a", tool: "editor" }]);
    openPanels(nodes, groupWith(nodes, "a"), "bottom", [{ url: "b", tool: "editor" }]);
    openPanels(nodes, groupWith(nodes, "a"), "right", [{ url: "c", tool: "editor" }]);
    openPanels(nodes, groupWith(nodes, "b"), "right", [{ url: "d", tool: "editor" }]);
  });
  assert.equal(shapeOf(doc.nodes), "column(row(a | c) | row(b | d))");
  const top = nodes => nodes[groupWith(nodes, "a")].parent;
  const bottom = nodes => nodes[groupWith(nodes, "b")].parent;
  const a = change(fork(doc), (nodes) => moveNode(nodes, top(nodes), groupWith(nodes, "d"), "bottom"));
  const b = change(fork(doc), (nodes) => moveNode(nodes, bottom(nodes), groupWith(nodes, "c"), "bottom"));
  const merged = Automerge.merge(fork(a), b);
  assertTree(merged.nodes);
  for (const url of ["a", "b", "c", "d"]) assert(findPanelShowing(merged.nodes, url), `${url} is lost`);
});

// ── lots of people doing lots of things ─────────────────────────────────────

// a seeded random, so a failure can be run again
function random(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

test("random edits by three people, merged in random orders, always read as a tree, and repairs agree", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rand = random(seed);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const zones = ["center", "left", "right", "top", "bottom"];
    let url = 0;
    let people = [base()];
    people.push(fork(people[0]), fork(people[0]));
    for (let round = 0; round < 12; round++) {
      people = people.map((doc) => {
        const ids = Object.keys(doc.nodes);
        if (!ids.length) return change(doc, (nodes) => openPanels(nodes, null, "center", [{ url: `u${url++}`, tool: "editor" }]));
        const panels = ids.filter((id) => doc.nodes[id].type === "panel");
        const holders = ids.filter((id) => doc.nodes[id].type !== "panel");
        const action = pick(["open", "open", "move", "move", "moveNode", "remove", "float", "row", "tool"]);
        return change(doc, (nodes) => {
          if (action === "open") openPanels(nodes, pick(holders), pick(zones), [{ url: `u${url++}`, tool: "editor" }]);
          if (action === "move" && panels.length) movePanel(nodes, pick(panels), pick(holders), pick(zones));
          if (action === "moveNode" && holders.length) moveNode(nodes, pick(holders), pick(holders), pick(zones));
          if (action === "remove" && panels.length > 2) remove(nodes, pick(panels));
          if (action === "float" && panels.length) float(nodes, pick([...panels, ...holders]), { x: 1, y: 2, w: 3, h: 4 });
          if (action === "row") addRow(nodes, newPanel(`u${url++}`, "editor"));
          if (action === "tool" && panels.length) setTool(nodes, pick(panels), pick(["editor", "visualizer"]));
        });
      });
      // some of them sync
      if (rand() < 0.6) {
        const [i, j] = [Math.floor(rand() * 3), Math.floor(rand() * 3)];
        if (i !== j) people[i] = Automerge.merge(people[i], people[j]);
      }
      for (const doc of people) assertTree(doc.nodes);
    }
    // everyone syncs, and everyone repairs what they see
    let all = people.reduce((a, b) => Automerge.merge(a, b));
    assertTree(all.nodes);
    const repaired = people.map(() => change(fork(all), (nodes) => repair(nodes)));
    all = repaired.reduce((a, b) => Automerge.merge(a, b));
    const seen = assertTree(all.nodes);
    // every panel in the doc is in the tree
    for (const id of Object.keys(all.nodes)) {
      if (all.nodes[id].type === "panel") assert(seen.has(id), `seed ${seed}: ${id} isn't in the tree`);
    }
    // and the repairs agreed, so there's nothing left to repair
    const again = change(fork(all), (nodes) => repair(nodes));
    assert.deepEqual(Automerge.getHeads(again), Automerge.getHeads(all), `seed ${seed}: repairs didn't agree`);
  }
});
