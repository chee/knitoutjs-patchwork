// the dock's layout, kept in the project doc as plain data:
//
//   split: {id, type: "split", direction: "row" | "column", sizes, children}
//   group: {id, type: "group", active, panels}
//   panel: {id, url, tool}
//
// a split's sizes are flex-basis percentages, one per child, adding up to 100.
// the functions here take a plain tree and return the new one (or null when
// nothing is left open); they may change the tree they're given

export function newId() {
  return crypto.randomUUID().slice(0, 8);
}

// `patchworkTool`: which of patchwork's tools a "patchwork" panel uses (when
// it isn't the one patchwork would pick)
export function newPanel(url, tool, patchworkTool) {
  return patchworkTool ? { id: newId(), url, tool, patchworkTool } : { id: newId(), url, tool };
}

export function newGroup(panels) {
  return {
    id: newId(),
    type: "group",
    active: panels[0]?.id ?? null,
    panels,
  };
}

export function newSplit(direction, children, sizes) {
  return {
    id: newId(),
    type: "split",
    direction,
    sizes: sizes ?? children.map(() => 100 / children.length),
    children,
  };
}

export function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  if (node.type !== "split") return null;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function findParent(node, id) {
  if (node?.type !== "split") return null;
  const index = node.children.findIndex((child) => child.id === id);
  if (index !== -1) return { parent: node, index };
  for (const child of node.children) {
    const found = findParent(child, id);
    if (found) return found;
  }
  return null;
}

export function findPanel(node, panelId) {
  if (!node) return null;
  if (node.type === "group") {
    const index = node.panels.findIndex((panel) => panel.id === panelId);
    return index === -1 ? null : { group: node, index };
  }
  for (const child of node.children) {
    const found = findPanel(child, panelId);
    if (found) return found;
  }
  return null;
}

// the first panel showing `url`: {group, index}
export function findPanelShowing(node, url) {
  if (!node) return null;
  if (node.type === "group") {
    const index = node.panels.findIndex((panel) => panel.url === url);
    return index === -1 ? null : { group: node, index };
  }
  for (const child of node.children) {
    const found = findPanelShowing(child, url);
    if (found) return found;
  }
  return null;
}

function scaleTo100(sizes) {
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
  return sizes.map((size) => (size / total) * 100);
}

// drop empty groups, unwrap splits with one child, and fold a split into its
// parent when they go the same way
export function normalize(node) {
  if (!node) return null;
  if (node.type === "group") return node.panels.length ? node : null;
  const children = [];
  const sizes = [];
  node.children.forEach((child, index) => {
    const size = node.sizes[index] ?? 100 / node.children.length;
    const kept = normalize(child);
    if (!kept) return;
    if (kept.type === "split" && kept.direction === node.direction) {
      kept.children.forEach((grandchild, j) => {
        children.push(grandchild);
        sizes.push((size * kept.sizes[j]) / 100);
      });
    } else {
      children.push(kept);
      sizes.push(size);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  node.children = children;
  node.sizes = scaleTo100(sizes);
  return node;
}

export function removePanel(root, panelId) {
  const found = findPanel(root, panelId);
  if (!found) return root;
  const { group, index } = found;
  group.panels.splice(index, 1);
  if (group.active === panelId) {
    group.active = group.panels[Math.min(index, group.panels.length - 1)]?.id ?? null;
  }
  return normalize(root);
}

// put a node (a new group, or a whole row) beside the node `targetId`, on
// one of its edges
export function placeBeside(root, targetId, edge, group) {
  const direction = edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  const target = findNode(root, targetId);
  if (!target) return root;
  const pair = before ? [group, target] : [target, group];
  if (root.id === targetId) return newSplit(direction, pair);
  const { parent, index } = findParent(root, targetId);
  if (parent.direction === direction) {
    // an even share for the new one, taken from everyone in the row (or
    // column), so no pane gets squeezed down to nothing
    const share = 100 / (parent.children.length + 1);
    parent.sizes = parent.sizes.map((size) => (size * (100 - share)) / 100);
    const at = before ? index : index + 1;
    parent.sizes.splice(at, 0, share);
    parent.children.splice(at, 0, group);
  } else {
    parent.children[index] = newSplit(direction, pair);
  }
  return root;
}

// open panels in the group `groupId`: as tabs ("center"), or in a new group
// on one of its edges. with nothing open yet, they become the whole layout
export function openPanels(root, groupId, zone, panels) {
  if (!panels.length) return root;
  const target = findNode(root, groupId);
  if (!root || !target) {
    if (!root) return newGroup(panels);
    zone = "right";
    groupId = root.id;
  }
  if (zone === "center" && target?.type === "group") {
    target.panels.push(...panels);
    target.active = panels[0].id;
    return root;
  }
  return placeBeside(root, groupId, zone, newGroup(panels));
}

export function movePanel(root, panelId, groupId, zone) {
  const from = findPanel(root, panelId);
  if (!from) return root;
  const panel = from.group.panels[from.index];
  if (from.group.id === groupId) {
    if (zone === "center") {
      from.group.active = panelId;
      return root;
    }
    // can't put a group's only panel beside itself
    if (from.group.panels.length === 1) return root;
  }
  root = removePanel(root, panelId);
  return openPanels(root, groupId, zone, [panel]);
}

export function setTool(root, panelId, tool, patchworkTool) {
  const found = findPanel(root, panelId);
  if (!found) return root;
  const panel = found.group.panels[found.index];
  panel.tool = tool;
  if (patchworkTool) panel.patchworkTool = patchworkTool;
  else delete panel.patchworkTool;
  return root;
}

export function activate(root, groupId, panelId) {
  const group = findNode(root, groupId);
  if (group) group.active = panelId;
  return root;
}

// add a node as a full-width row under everything, with an even share of the
// height (a layout that's already a column of rows makes room for one more)
export function addRow(root, node) {
  if (!root) return node;
  if (root.type === "split" && root.direction === "column") {
    const share = 100 / (root.children.length + 1);
    root.sizes = root.sizes.map((size) => (size * (100 - share)) / 100);
    root.sizes.push(share);
    root.children.push(node);
    return root;
  }
  return newSplit("column", [root, node]);
}
