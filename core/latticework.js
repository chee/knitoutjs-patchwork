// latticework: a project's panes, and its files down the side. what each
// app's project tool shows, and what lattice's frame has in its middle
import { createSignal, createMemo, createEffect, on, onCleanup, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import html from "solid-js/html";
import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import { getHeads, inspectChange } from "@automerge/automerge";
import {
  getFallbackTool,
  getRegistry,
  getSupportedToolsForType,
} from "@inkandswitch/patchwork-plugins";
import { docColour, docText, shortUrl, newFileDoc, textHash } from "./files.js";
import * as Layout from "./layout.js";
import { urlFromText, loadDatatype, createDocOfDatatype } from "./patchwork-docs.js";
import defaultSource from "./default-source.js";
import { Resizer, sidebarState } from "./sidebars.js";
import { icon } from "./icons.js";
import { builds, setBuild } from "./builds.js";
import { readActive, writeActive, activeChannel } from "./active.js";

const STYLESHEET = new URL("./latticework.css", import.meta.url).href;

// "just now", "4 min ago": how long since a .k was built
function ago(time, now) {
  const seconds = (now - time) / 1000;
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `on ${new Date(time).toLocaleDateString()}`;
}

// when a doc was last changed, by anyone: the latest of its newest changes
// (automerge stamps each one with the time, in seconds)
function editedAt(doc) {
  try {
    const times = getHeads(doc).map((hash) => inspectChange(doc, hash)?.time ?? 0);
    const latest = Math.max(0, ...times);
    return latest ? latest * 1000 : null;
  } catch {
    return null;
  }
}

const MIN_CELL = 80;
const EDGE = 0.22;
const MAX_EDGE = 64;
const CODE_EDGE = 28;
const OUTER_EDGE = 10;

// a drag goes out to everyone else looking this often, and again now and
// then while it's held still. theirs shows until the doc has it, or until
// they've been quiet this long (their page shut mid-drag, say)
const LIVE_EVERY = 33;
const LIVE_QUIET = 4000;

// a floating window: how small it gets, how much of it stays in reach, and
// the edges and corners it's sized by
const FLOAT_MIN = { w: 200, h: 120 };
const FLOAT_REACH = { x: 80, y: 34 };
const FLOAT_EDGES = ["n", "e", "s", "w", "ne", "se", "sw", "nw"];

// a node's fields while it's dragged: its size (a divider) or where it
// floats. anything else that comes over broadcast is ignored
const numbers = (value, keys) =>
  !!value && typeof value === "object" && keys.every((key) => Number.isFinite(value[key]));
function liveFields(fields) {
  const out = {};
  const size = fields?.size;
  if (numbers(size, ["flex"]) || numbers(size, ["px"])) out.size = { ...size };
  if (numbers(fields?.float, ["x", "y", "w", "h", "z"])) out.float = { ...fields.float };
  return Object.keys(out).length ? out : null;
}

// two sizes or two floats are the same
function sameFields(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key]);
}

// what can be dragged in: our own tabs, the tools in a tab's tool menu (to
// open that file with that tool somewhere else), and docs from the sidebar
const PANEL_TYPE = "application/x-knitoutjs-panel";
const TOOL_TYPE = "application/x-knitoutjs-tool";
// drags that place a pane, rather than bring a doc in
const LAYOUT_TYPES = [PANEL_TYPE, TOOL_TYPE];
const DOC_TYPES = ["text/x-patchwork-dnd", "text/x-patchwork-urls", "text/uri-list"];

function isOurDrag(dataTransfer) {
  return [...LAYOUT_TYPES, ...DOC_TYPES].some((type) => dataTransfer?.types.includes(type));
}

// [{url, name?}], read the same way the sidebar reads its own drops
function droppedDocs(dataTransfer) {
  try {
    const items = JSON.parse(dataTransfer.getData("text/x-patchwork-dnd"))?.items;
    if (Array.isArray(items) && items.length) return items;
  } catch {}
  try {
    const urls = JSON.parse(dataTransfer.getData("text/x-patchwork-urls"));
    if (Array.isArray(urls)) {
      return urls.filter((url) => isValidAutomergeUrl(url)).map((url) => ({ url }));
    }
  } catch {}
  return (dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain"))
    .split(/\r?\n/)
    .map(urlFromText)
    .filter(Boolean)
    .map((url) => ({ url }));
}

// which part of a group the pointer is over: a band along an edge to split,
// or the middle. `band` is the band's width in pixels
function zoneAt(event, rect, band) {
  const across = band ?? Math.min(rect.width * EDGE, MAX_EDGE);
  const down = band ?? Math.min(rect.height * EDGE, MAX_EDGE);
  const distances = {
    left: (event.clientX - rect.left) / across,
    right: (rect.right - event.clientX) / across,
    top: (event.clientY - rect.top) / down,
    bottom: (rect.bottom - event.clientY) / down,
  };
  const [edge, distance] = Object.entries(distances).sort((a, b) => a[1] - b[1])[0];
  return distance < 1 ? edge : "center";
}

// the groups in a read tree, in the order they're laid out
function* groupsIn(node) {
  if (!node) return;
  if (node.type === "group") yield node;
  else for (const child of node.children) yield* groupsIn(child);
}

// a cell's flex, from its node's size: a share of what's left, or fixed
function cellStyle(node, direction) {
  const size = node.size ?? { flex: 1 };
  const style = size.px != null ? { flex: `0 0 ${size.px}px` } : { flex: `${size.flex} 1 0px` };
  const along = direction === "row" ? "width" : "height";
  if (node.min != null) style[`min-${along}`] = `${node.min}px`;
  if (node.max != null) style[`max-${along}`] = `${node.max}px`;
  return style;
}

/**
 * a project's panes, and its files down the side. returns a way to unmount.
 *
 *   layout     the handle of its layout doc ({nodes}: see layout.js)
 *   files      its files: an adapter, like folder.js's folderFiles
 *   repo       finds and makes docs. through a draft overlay, if there is
 *              one, so what's done here goes into whichever draft is out
 *   baseRepo   for tools that mustn't be forked into a draft (a terminal:
 *              latticex is on the original). repo, if not given
 *   hive       the site's keyhive, if it has one, for new docs
 *   tools      the app's {TOOLS, toolsFor, fileExtension}: which tools show
 *              which files
 *   self       tool ids never offered in a pane (the app's own project and
 *              frame tools: not inside a pane of themselves)
 *   sidebar    the files sidebar's state (sidebars.js), when something else
 *              opens and shuts it (lattice's top bar). without one, it keeps
 *              its own, with a strip down the side to open it again
 *   menu       more for the + menu: [{icon, label, detail, alt, create}].
 *              `alt` ones show while alt is held; create(groupId) makes a
 *              doc and returns its url, which opens
 *   onShowing  hears the docs the panes are showing ({url, name}, one per
 *              pane), for inspectors
 *   onOpen     gets a way to bring a doc forward
 */
export function mountLatticework(
  element,
  {
    layout: layoutHandle,
    files,
    repo,
    baseRepo = repo,
    hive,
    tools: { TOOLS, toolsFor, fileExtension },
    self = [],
    sidebar,
    menu: extraItems = [],
    onShowing,
    onOpen,
  },
) {
  let root;
  let menu;

  const filesSidebar = sidebar ?? sidebarState("files", 200);

  // a stylesheet added by script doesn't hold up painting, so stay hidden
  // until it's in, or you see the whole thing unstyled first
  const [styled, setStyled] = createSignal(false);

  // ── what's in the project ──────────────────────────────────────────────

  const [layout, setLayout] = createStore({ root: null, floats: [] });
  const [fileUrls, setFileUrls] = createSignal([]);
  const [projectName, setProjectName] = createSignal("");

  // what's being dragged right now, here or by anyone else looking: {[node
  // id]: {fields: {size} or {float}, until}}. it's shown over the doc until
  // the doc has it too, or until it lapses
  const live = new Map();
  let lapse = null;

  function readLayout() {
    const nodes = layoutHandle.doc()?.nodes ?? {};
    const shown = { ...nodes };
    const now = Date.now();
    let soonest = Infinity;
    for (const [id, { fields, until }] of live) {
      const node = nodes[id];
      const caughtUp = node && Object.entries(fields).every(([key, value]) => sameFields(node[key], value));
      if (!node || caughtUp || until <= now) {
        live.delete(id);
        continue;
      }
      shown[id] = { ...node, ...fields };
      soonest = Math.min(soonest, until);
    }
    clearTimeout(lapse);
    if (soonest < Infinity) lapse = setTimeout(readLayout, soonest - now + 10);
    setLayout(reconcile(Layout.read(shown), { key: "id" }));
  }
  function readFiles() {
    setFileUrls(files.urls());
    setProjectName(files.title());
  }
  readLayout();
  readFiles();
  layoutHandle.on("change", readLayout);
  const offFiles = files.subscribe(readFiles);

  // an edit from layout.js, on the doc's nodes. returns what the edit does
  function updateLayout(edit) {
    let result;
    layoutHandle.change((doc) => {
      doc.nodes ??= {};
      result = edit(doc.nodes);
    });
    return result;
  }

  const allGroups = () => [layout.root, ...layout.floats].flatMap((node) => [...groupsIn(node)]);
  const findGroup = (id) => allGroups().find((group) => group.id === id) ?? null;

  // the first pane showing a doc: {group, panel}
  function findShowing(url) {
    for (const group of allGroups()) {
      const panel = group.panels.find((panel) => panel.url === url);
      if (panel) return { group, panel };
    }
    return null;
  }

  // which tab each group is showing. it's this browser's, not the doc's
  // (active.js): remembered for next time, and this browser's other tabs
  // follow along
  const [active, setActive] = createStore(readActive(layoutHandle.url));
  const activeIn = (group) => group.panels.find((panel) => panel.id === active[group.id]) ?? group.panels[0];
  const tabChannel = activeChannel(layoutHandle.url, (groupId, panelId) => setActive(groupId, panelId));

  function showTab(groupId, panelId) {
    if (!groupId || !panelId || active[groupId] === panelId) return;
    setActive(groupId, panelId);
    tabChannel.post(groupId, panelId);
    // only what still points at a tab in its group
    const nodes = layoutHandle.doc()?.nodes ?? {};
    const kept = {};
    for (const [group, panel] of Object.entries(active)) if (nodes[panel]?.parent === group) kept[group] = panel;
    writeActive(layoutHandle.url, kept);
  }
  function activate(panelId) {
    showTab(layoutHandle.doc()?.nodes?.[panelId]?.parent, panelId);
  }

  const addFiles = (urls) => files.add(urls);

  // name, extension and links of any doc we show, kept up to date
  const infos = new Map();
  function docInfo(url) {
    if (!url) return {};
    let entry = infos.get(url);
    if (!entry) {
      const [info, setInfo] = createStore({
        name: shortUrl(url),
        extension: "",
        target: null,
        source: null,
        editable: false,
        copyOf: null,
        type: null,
        builtAt: null,
        editedAt: null,
        sourceHash: null,
        textHash: null,
      });
      entry = { info, off: null };
      infos.set(url, entry);
      repo
        .find(url)
        .then(async (docHandle) => {
          // a doc that isn't a file (markdown, say) may only have a title its
          // datatype can find in it
          const datatype = await loadDatatype(docHandle.doc()?.["@patchwork"]?.type);
          const update = () => {
            const doc = docHandle.doc();
            setInfo({
              name: doc?.name || doc?.title || datatype?.module.getTitle?.(doc) || shortUrl(url),
              extension: fileExtension(doc),
              target: doc?.knitoutTarget ?? null,
              source: doc?.knitoutSource ?? null,
              editable: typeof doc?.content === "string",
              copyOf: doc?.knitoutCopyOf ?? null,
              type: doc?.["@patchwork"]?.type ?? null,
              // a .k: when it was built, and from what code
              builtAt: doc?.knitoutBuiltAt ?? null,
              // anything else: when it was last changed (a built .k's newest
              // change is its whole knitout, which isn't worth unpacking)
              editedAt: doc?.knitoutBuiltAt ? null : editedAt(doc),
              sourceHash: doc?.knitoutSourceHash ?? null,
              // a .js: its code now, to tell the .k it writes is out of date
              textHash: fileExtension(doc) === "js" ? textHash(docText(doc)) : null,
            });
          };
          update();
          docHandle.on("change", update);
          entry.off = () => docHandle.off("change", update);
        })
        .catch(() => setInfo({ name: `missing ${shortUrl(url)}` }));
    }
    return entry.info;
  }

  const projectFiles = createMemo(() =>
    fileUrls().map((url) => {
      const info = docInfo(url);
      return { url, name: info.name, extension: info.extension };
    }),
  );

  async function createFile(name, extra = {}) {
    const taken = new Set(projectFiles().map((file) => file.name));
    const [, stem, ext] = name.match(/^(.*?)(\..*)?$/);
    let unique = name;
    for (let n = 2; taken.has(unique); n++) unique = `${stem}-${n}${ext ?? ""}`;
    const fileHandle = await repo.create2({ ...newFileDoc(unique), ...extra });
    addFiles([fileHandle.url]);
    return fileHandle.url;
  }

  // ── links: hovering anything that shows a doc lights up every pane that
  //    shows it, and more softly the panes showing the docs it's linked to

  const [hovered, setHovered] = createSignal(null);

  // linked = a .js and the .k it writes into now (a .k also remembers which
  // .js wrote it last, but that's history, so it doesn't light up), and a .k
  // and its editable copy
  function linked(a, b) {
    const one = docInfo(a);
    const two = docInfo(b);
    return one.target === b || two.target === a || one.copyOf === b || two.copyOf === a;
  }

  function glow(url) {
    const lit = hovered();
    if (!lit || !url) return undefined;
    if (lit === url) return "same";
    return linked(lit, url) ? "linked" : undefined;
  }

  const unhover = () => setHovered(null);

  // light a doc up for a moment, when it's been brought forward
  function flashDoc(url) {
    setHovered(url);
    setTimeout(() => hovered() === url && setHovered(null), 900);
  }

  // a doc open in more than one pane is marked out in each, in its colour
  const paneCounts = createMemo(() => {
    const counts = new Map();
    for (const group of allGroups()) {
      for (const url of new Set(group.panels.map((panel) => panel.url))) {
        counts.set(url, (counts.get(url) ?? 0) + 1);
      }
    }
    return counts;
  });
  const inManyPanes = (url) => (paneCounts().get(url) ?? 0) > 1;

  // ── builds: a generated .k says how up to date it is. a "now" that ticks,
  //    for how long ago it was built
  const [clock, setClock] = createSignal(Date.now());
  const ticker = setInterval(() => setClock(Date.now()), 15_000);

  // build a .js into its .k again: by its editor, if it's open in one, so
  // its build bar shows it too
  async function rebuild(jsUrl, kUrl) {
    const builder = builds[jsUrl]?.builder;
    if (builder) return builder.now();
    const [{ runInto }, jsHandle, kHandle] = await Promise.all([
      import("./run.js"),
      repo.find(jsUrl),
      repo.find(kUrl),
    ]);
    setBuild(jsUrl, { state: "running", line: undefined, message: undefined });
    const { error } = await runInto(jsHandle, kHandle, repo);
    setBuild(
      jsUrl,
      error
        ? { state: "error", line: error.line ?? undefined, message: String(error.message ?? error) }
        : { state: "ok" },
    );
  }

  // how a generated .k is doing: built, building, out of date, or its .js
  // failed. null once its .js writes somewhere else
  function buildState(kUrl) {
    const info = docInfo(kUrl);
    const source = info.source ? docInfo(info.source) : null;
    if (source?.target !== kUrl) return null;
    const build = builds[info.source] ?? {};
    if (build.state === "running") return "running";
    if (build.state === "error") return "error";
    const outOfDate = !!info.sourceHash && !!source.textHash && info.sourceHash !== source.textHash;
    // with autobuild on, it's about to build anyway
    if (outOfDate) return build.auto && build.builder ? "running" : "stale";
    return "built";
  }

  // a generated .k that isn't keeping up with its .js: it failed, or it's out
  // of date, or it's building again after failing
  function stuck(kUrl) {
    const state = buildState(kUrl);
    if (state === "error" || state === "stale") return true;
    return state === "running" && !!builds[docInfo(kUrl).source]?.failed;
  }

  // a build that failed: show the .js, at the line it failed on
  async function showError(jsUrl, fromPanelId) {
    await reveal(jsUrl, fromPanelId, "left", "editor");
    const line = builds[jsUrl]?.line;
    if (line != null) builds[jsUrl]?.builder?.goToLine(line);
  }

  // ── tools: each panel's tool lives in its own element, which moves with
  //    the panel when the layout changes rather than starting over

  // show a linked doc: if it's open already, bring its tab forward and light
  // it up for a moment; if not, open it on one side of the pane asking
  async function reveal(url, fromPanelId, edge, toolId) {
    if (!url) return;
    const showing = findShowing(url);
    if (showing) {
      showTab(showing.group.id, showing.panel.id);
    } else {
      const doc = (await repo.find(url)).doc();
      const tool = toolId ?? toolsFor(fileExtension(doc))[0].id;
      addFiles([url]);
      const [id] = updateLayout((nodes) =>
        Layout.openPanels(nodes, fromPanelId, edge, [Layout.newPanel(url, tool)]),
      );
      activate(id);
    }
    flashDoc(url);
  }

  // a generated .k is read only (it's stored whole, which keeps big ones
  // fast); this makes a plain-text copy beside it to edit by hand
  async function editableCopy(panel) {
    const doc = (await repo.find(panel.url)).doc();
    const stem = (doc?.name ?? "pattern.k").replace(/\.k$/, "");
    const copy = await createFile(`${stem}-copy.k`, {
      content: docText(doc),
      knitoutCopyOf: panel.url,
    });
    reveal(copy, panel.id, "right", "editor");
  }

  function panelOf(toolElement) {
    for (const [id, host] of hosts) if (host.el === toolElement) return id;
    return null;
  }

  const toolContext = {
    repo,
    open: (url, toolElement, edge, toolId) => reveal(url, panelOf(toolElement), edge, toolId),
    openIfClosed: (url, toolElement, edge, toolId) =>
      findShowing(url) || reveal(url, panelOf(toolElement), edge, toolId),
    editableCopy: (url, toolElement) => editableCopy({ id: panelOf(toolElement), url }),
    get events() {
      return root;
    },
    project: { files: projectFiles, createFile },
    hover: setHovered,
  };

  const hosts = new Map();

  function hostFor(panel) {
    const { id, url, tool, patchworkTool } = panel;
    let host = hosts.get(id);
    if (host && host.url === url && host.tool === tool && host.patchworkTool === patchworkTool) {
      return host;
    }
    if (host) destroyHost(id, host);
    host = { url, tool, patchworkTool, el: document.createElement("div"), cleanup: null };
    host.el.className = "knitoutjs-tool";
    hosts.set(id, host);
    mountTool(host);
    return host;
  }

  // say a pane's doc is mounted (or not) as a <patchwork-view> would, so
  // providers above know what's open: comments watches those docs for
  // threads, and drafts lists them. from latticework's element, which is
  // still in the page when a pane's own has already gone
  function announce(type, host) {
    element.dispatchEvent(
      new CustomEvent(type, {
        detail: { url: host.url, toolId: `latticework:${host.tool}` },
        bubbles: true,
        composed: true,
      }),
    );
  }

  async function mountTool(host) {
    const tool = TOOLS[host.tool] ?? TOOLS.patchwork;
    try {
      const [docHandle, module] = await Promise.all([
        (tool.drafts === false ? baseRepo : repo).find(host.url),
        tool.load(),
      ]);
      if (host.dead) return;
      host.cleanup = module.default(docHandle, host.el, {
        ...toolContext,
        toolId: host.patchworkTool,
      });
      host.announced = true;
      announce("patchwork:mounted", host);
    } catch (error) {
      if (host.dead) return;
      host.el.classList.add("knitoutjs-tool-broken");
      host.el.textContent = `couldn't open this: ${error.message ?? error}`;
    }
  }

  function destroyHost(id, host) {
    if (host.dead) return;
    host.dead = true;
    host.cleanup?.();
    if (host.announced) announce("patchwork:unmounted", host);
    host.el.remove();
    if (hosts.get(id) === host) hosts.delete(id);
  }

  function Slot(props) {
    const panel = props.panel;
    let slot;
    createEffect(() => {
      const host = hostFor(panel);
      slot.replaceChildren(host.el);
      const owner = {};
      host.owner = owner;
      // if nobody picks it up again this tick, it's really gone
      onCleanup(() =>
        queueMicrotask(() => {
          if (host.owner === owner && !host.el.isConnected) {
            destroyHost(panel.id, host);
          }
        }),
      );
    });
    return html`<div class="knitoutjs-slot" ref=${(el) => (slot = el)}></div>`;
  }

  // ── opening things ─────────────────────────────────────────────────────

  const [notice, setNotice] = createSignal(null);
  let noticeTimer;
  function notify(groupId, text) {
    clearTimeout(noticeTimer);
    setNotice({ groupId, text });
    noticeTimer = setTimeout(() => setNotice(null), 3500);
  }

  // the pane last clicked in: where things opened from the files go
  let lastGroupId = null;

  async function openDocs(urls, groupId, zone = "center") {
    groupId ??= findGroup(lastGroupId) ? lastGroupId : null;
    const panels = [];
    const refused = [];
    for (const url of urls) {
      try {
        const doc = (await repo.find(url)).doc();
        panels.push(Layout.newPanel(url, toolsFor(fileExtension(doc))[0].id));
      } catch {
        refused.push(shortUrl(url));
      }
    }
    if (panels.length) {
      addFiles(panels.map((panel) => panel.url));
      const [first] = updateLayout((nodes) => Layout.openPanels(nodes, groupId, zone, panels));
      activate(first);
    }
    if (refused.length) {
      notify(groupId, `couldn't find ${refused.join(", ")}`);
    }
  }

  // a .js and the .k it writes, side by side on a row of their own
  async function newPattern() {
    const k = await createFile("pattern.k");
    const js = await createFile("pattern.knitout.js", {
      content: defaultSource,
      knitoutTarget: k,
    });
    updateLayout((nodes) =>
      Layout.addRow(
        nodes,
        Layout.newSplit("row", [
          Layout.newGroup([Layout.newPanel(js, "editor")]),
          Layout.newGroup([Layout.newPanel(k, "visualizer")]),
        ]),
      ),
    );
    const [{ runInto }, jsHandle, kHandle] = await Promise.all([
      import("./run.js"),
      repo.find(js),
      repo.find(k),
    ]);
    runInto(jsHandle, kHandle, repo);
  }

  async function newFile(groupId, name) {
    openDocs([await createFile(name)], groupId);
  }

  // a doc of one of patchwork's own datatypes, as its sidebar makes them
  async function newDoc(groupId, type) {
    const datatype = await loadDatatype(type);
    if (!datatype) {
      notify(groupId, `there's no ${type} here`);
      return;
    }
    const handle = await createDocOfDatatype(datatype, repo, undefined, hive);
    openDocs([handle.url], groupId);
  }

  // one of the app's own: it makes the doc, and it opens here
  async function newExtra(groupId, item) {
    const url = await item.create(groupId);
    if (url) openDocs([url], groupId);
  }

  const [menuFor, setMenuFor] = createSignal(null);
  // the menu has more in it while alt is held
  const [altHeld, setAltHeld] = createSignal(false);
  const onAltKey = (event) => {
    if (event.key === "Alt") setAltHeld(event.type === "keydown");
  };
  document.addEventListener("keydown", onAltKey);
  document.addEventListener("keyup", onAltKey);

  function openMenu(event, groupId) {
    setAltHeld(event.altKey);
    setMenuFor(groupId);
    const rect = event.currentTarget.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 280))}px`;
    menu.showPopover();
  }

  // ── what a pane's shown with: one of ours, or, for a doc we've no tool
  //    of our own for, one of the patchwork tools for its datatype (patchwork's
  //    own pick, unless the pane says which). those arrive as packages load

  const patchworkTools = getRegistry("patchwork:tool");
  const [patchworkToolsChanged, setPatchworkToolsChanged] = createSignal(0);
  const offPatchworkTools = patchworkTools.on("changed", () =>
    setPatchworkToolsChanged((n) => n + 1),
  );

  // the one patchwork would pick first. not frames, nor the app's own tools
  // (not inside a pane of themselves)
  function patchworkToolsFor(type) {
    patchworkToolsChanged();
    if (!type) return [];
    let first;
    try {
      first = getFallbackTool({ "@patchwork": { type } })?.id;
    } catch {}
    return getSupportedToolsForType(type)
      .filter(
        (tool) =>
          !tool.unlisted &&
          !tool.forTitleBar &&
          !tool.tags?.includes("frame-tool") &&
          !self.includes(tool.id),
      )
      .sort((a, b) => (b.id === first) - (a.id === first) || a.name.localeCompare(b.name));
  }

  // [{tool, patchworkTool?, name, title}]
  function toolChoices(url) {
    const info = docInfo(url);
    return toolsFor(info.extension)
      .sort((a, b) => a.position - b.position)
      .flatMap((tool) => {
        const theirs = tool.id === "patchwork" ? patchworkToolsFor(info.type) : [];
        if (!theirs.length) return [{ tool: tool.id, name: tool.name, title: tool.title }];
        return theirs.map((theirTool) => ({
          tool: tool.id,
          patchworkTool: theirTool.id,
          name: theirTool.name.toLowerCase(),
          title: `patchwork's ${theirTool.name} tool`,
        }));
      });
  }

  function shownWith(panel) {
    const choices = toolChoices(panel.url);
    return (
      choices.find(
        (choice) =>
          choice.tool === panel.tool &&
          (!panel.patchworkTool || choice.patchworkTool === panel.patchworkTool),
      ) ?? null
    );
  }

  function toolName(panel) {
    return shownWith(panel)?.name ?? TOOLS[panel.tool]?.name ?? panel.tool;
  }

  // a tab's tool menu: what it's shown with, and what else it could be
  let toolMenu;
  const [toolMenuFor, setToolMenuFor] = createSignal(null);

  function openToolMenu(event, panel, groupId) {
    setToolMenuFor({ panel, groupId });
    const rect = event.currentTarget.getBoundingClientRect();
    toolMenu.style.top = `${rect.bottom + 4}px`;
    toolMenu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 220))}px`;
    toolMenu.showPopover();
  }

  function fromMenu(action) {
    return (...args) => {
      const groupId = menuFor();
      menu.hidePopover();
      action(groupId, ...args);
    };
  }

  function onOpenUrl(event) {
    event.preventDefault();
    const input = event.currentTarget.elements.url;
    const url = urlFromText(input.value);
    if (!url) {
      input.setCustomValidity("that isn't an automerge url");
      input.reportValidity();
      return;
    }
    input.value = "";
    fromMenu((groupId) => openDocs([url], groupId))();
  }

  // ── dragging tabs and docs ─────────────────────────────────────────────

  const [dragging, setDragging] = createSignal(false);
  // dropping along the frame's own edge splits the whole layout, so a row
  // can run all the way across (a .k and its visualizer above everything)
  const [outerZone, setOuterZone] = createSignal(null);

  function outerEdgeAt(event) {
    if (!layout.root) return null;
    const rect = root.getBoundingClientRect();
    if (event.clientX - rect.left < OUTER_EDGE) return "left";
    if (rect.right - event.clientX < OUTER_EDGE) return "right";
    if (event.clientY - rect.top < OUTER_EDGE) return "top";
    if (rect.bottom - event.clientY < OUTER_EDGE) return "bottom";
    return null;
  }

  // the pane under the pointer while something's dragged over, and where in
  // it: {groupId, zone, lineTop}. the panes only show this; latticework works
  // it out, at its root, so nothing inside a pane (an editor, a canvas) can
  // take the drop first
  const [dropTarget, setDropTarget] = createSignal(null);
  const dropTargets = new Map(); // group id → (event) => {zone, lineTop}

  // browsers often leave dragleave's relatedTarget empty, so count instead:
  // every element entered is left again
  let entered = 0;

  // the drop effect to answer with, for what's being dragged
  function dropEffectFor(dataTransfer) {
    return dataTransfer.types.includes(PANEL_TYPE) ? "move" : "copy";
  }

  function onRootDragEnter(event) {
    if (!isOurDrag(event.dataTransfer)) return;
    // safari only lets an element be dropped on if it cancels dragenter as
    // well as dragover (as the spec says); chrome only needs dragover
    event.preventDefault();
    event.dataTransfer.dropEffect = dropEffectFor(event.dataTransfer);
    entered++;
    setDragging(true);
  }
  function onRootDragLeave() {
    if (!dragging()) return;
    entered = Math.max(0, entered - 1);
    if (entered === 0) stopDragging();
  }
  function stopDragging() {
    entered = 0;
    setDragging(false);
    setOuterZone(null);
    setDropTarget(null);
  }
  // dragged away somewhere else on the page, or let go of
  const onDocumentDragOver = (event) => {
    if (dragging() && !root.contains(event.target)) stopDragging();
  };
  document.addEventListener("dragover", onDocumentDragOver);
  document.addEventListener("dragend", stopDragging);
  document.addEventListener("drop", stopDragging);

  // where a drop would land: the outer edge, a pane and a zone of it, or
  // (with nothing open) the whole frame
  function dropTargetAt(event) {
    const outer = outerEdgeAt(event);
    if (outer) return { groupId: layout.root.id, zone: outer, outer: true };
    const section = event.target.closest?.(".knitoutjs-group");
    const zoneFor = section && dropTargets.get(section.dataset.group);
    if (zoneFor) return { groupId: section.dataset.group, ...zoneFor(event) };
    if (!layout.root) return { groupId: null, zone: "center" };
    return null;
  }

  function onRootDragOver(event) {
    if (!isOurDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = dropEffectFor(event.dataTransfer);
    if (!dragging()) setDragging(true);
    const target = dropTargetAt(event);
    setOuterZone(target?.outer ? target.zone : null);
    setDropTarget(target && !target.outer ? target : null);
  }

  function onRootDrop(event) {
    if (!isOurDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = dropTargetAt(event);
    stopDragging();
    if (!target) return;
    const group = target.groupId && findGroup(target.groupId);
    drop(event, target.groupId, target.zone, group ? activeIn(group) : null);
  }

  function listenForDrops(el) {
    el.addEventListener("dragenter", onRootDragEnter, true);
    el.addEventListener("dragleave", onRootDragLeave, true);
    el.addEventListener("dragover", onRootDragOver, true);
    el.addEventListener("drop", onRootDrop, true);
  }

  function drop(event, groupId, zone, activePanel) {
    const dataTransfer = event.dataTransfer;
    const panelId = dataTransfer.getData(PANEL_TYPE);
    if (panelId) {
      updateLayout((nodes) => Layout.movePanel(nodes, panelId, groupId, zone));
      activate(panelId);
      return;
    }
    const tool = dataTransfer.getData(TOOL_TYPE);
    if (tool) {
      const { url, id, patchworkTool } = JSON.parse(tool);
      const at = zone === "code" ? "center" : zone;
      const [made] = updateLayout((nodes) =>
        Layout.openPanels(nodes, groupId, at, [Layout.newPanel(url, id, patchworkTool)]),
      );
      activate(made);
      return;
    }
    const docs = droppedDocs(dataTransfer);
    if (zone === "code") {
      hosts.get(activePanel?.id)?.el.dropInto?.drop(docs, event.clientX, event.clientY);
      return;
    }
    openDocs(
      docs.map((doc) => doc.url),
      groupId,
      zone,
    );
  }

  // ── live drags: a divider or a floating window, shown as it goes, here
  //    and to everyone else looking (over the layout doc's broadcast), and
  //    written to the doc once, when it's let go of

  // what's being dragged here: a divider's direction, "move", or the edge a
  // floating window's being sized by. it sets the cursor
  const [resizing, setResizing] = createSignal(null);

  const me = Layout.newId();
  let sent = 0;
  let outgoing = {};
  let sendTimer = null;

  function send() {
    clearTimeout(sendTimer);
    sendTimer = null;
    if (!Object.keys(outgoing).length) return;
    try {
      layoutHandle.broadcast({ latticework: "drag", from: me, n: ++sent, nodes: outgoing });
    } catch {}
    outgoing = {};
  }

  // theirs. messages can come out of order, so an older one is dropped
  const heard = new Map();
  function onDragMessage({ message }) {
    if (message?.latticework !== "drag" || typeof message.from !== "string" || message.from === me) return;
    if (!(message.n > (heard.get(message.from) ?? 0))) return;
    heard.set(message.from, message.n);
    const until = Date.now() + LIVE_QUIET;
    for (const [id, fields] of Object.entries(message.nodes ?? {})) {
      const checked = liveFields(fields);
      if (checked) live.set(id, { fields: checked, until });
    }
    readLayout();
  }
  layoutHandle.on("ephemeral-message", onDragMessage);

  // a drag from `event`'s pointer: fieldsAt(event) says what the nodes are
  // now ({[id]: {size} or {float}}), and write(nodes, fields) puts that in
  // the doc when it's let go of
  function dragLive(event, cursor, fieldsAt, write) {
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setResizing(cursor);
    let fields = null;
    // held still, it still goes out now and then, so it doesn't lapse
    const beat = setInterval(() => {
      if (fields) Object.assign(outgoing, fields), send();
    }, LIVE_QUIET / 3);

    function onMove(event) {
      fields = fieldsAt(event);
      for (const [id, each] of Object.entries(fields)) live.set(id, { fields: each, until: Infinity });
      readLayout();
      Object.assign(outgoing, fields);
      sendTimer ??= setTimeout(send, LIVE_EVERY);
    }

    function onUp() {
      clearInterval(beat);
      setResizing(null);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      if (!fields) return;
      send();
      for (const id of Object.keys(fields)) {
        const entry = live.get(id);
        if (entry) entry.until = Date.now() + LIVE_QUIET;
      }
      updateLayout((nodes) => write(nodes, fields));
      readLayout();
    }

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  // a divider: the two cells either side of it. a fixed one stays fixed (in
  // px), and two flexible ones share what they had between them
  function startResize(event, split, left) {
    if (event.button !== 0) return;
    const resizer = event.currentTarget;
    const row = split.direction === "row";
    const a = split.children[left];
    const b = split.children[left + 1];
    const length = (el) => el.getBoundingClientRect()[row ? "width" : "height"];
    const lengthA = length(resizer.previousElementSibling);
    const pair = lengthA + length(resizer.nextElementSibling);
    const lowest = Math.max(Math.min(MIN_CELL, pair / 2), a.min ?? 0, pair - (b.max ?? Infinity));
    const highest = Math.min(pair - Math.max(Math.min(MIN_CELL, pair / 2), b.min ?? 0), a.max ?? Infinity);
    const sizeA = { ...a.size };
    const sizeB = { ...b.size };
    const start = row ? event.clientX : event.clientY;

    function sizesFor(lengthOfA) {
      const lengthOfB = pair - lengthOfA;
      if (sizeA.px != null && sizeB.px != null) {
        return [{ px: Math.round(lengthOfA) }, { px: Math.round(lengthOfB) }];
      }
      if (sizeA.px != null) return [{ px: Math.round(lengthOfA) }, sizeB];
      if (sizeB.px != null) return [sizeA, { px: Math.round(lengthOfB) }];
      const flex = sizeA.flex + sizeB.flex;
      return [{ flex: (flex * lengthOfA) / pair }, { flex: (flex * lengthOfB) / pair }];
    }

    dragLive(
      event,
      row ? "row" : "column",
      (event) => {
        const delta = (row ? event.clientX : event.clientY) - start;
        const [one, two] = sizesFor(Math.min(Math.max(lengthA + delta, lowest), Math.max(lowest, highest)));
        return { [a.id]: { size: one }, [b.id]: { size: two } };
      },
      (nodes, fields) => Layout.resize(nodes, { [a.id]: fields[a.id].size, [b.id]: fields[b.id].size }),
    );
  }

  // ── floating windows: moved by their tab bars, sized by their edges and
  //    corners, and brought to the front when touched

  // how big the frame is, to keep floats in reach on a smaller screen than
  // the one they were put on
  const [frameSize, setFrameSize] = createSignal(null);
  const frameObserver = new ResizeObserver(([entry]) =>
    setFrameSize({ w: entry.contentRect.width, h: entry.contentRect.height }),
  );

  // where a float shows: where it is, kept in reach
  function floatBox(float) {
    const frame = frameSize();
    if (!frame) return float;
    const w = Math.min(float.w, frame.w);
    const h = Math.min(float.h, frame.h);
    return {
      w,
      h,
      x: Math.max(FLOAT_REACH.x - w, Math.min(float.x, frame.w - FLOAT_REACH.x)),
      y: Math.max(0, Math.min(float.y, frame.h - FLOAT_REACH.y)),
    };
  }

  // the top node a panel, group or split is in, from the doc
  function topOf(id) {
    const nodes = layoutHandle.doc()?.nodes ?? {};
    while (nodes[id]?.parent != null) id = nodes[id].parent;
    return nodes[id] ? id : null;
  }
  const isFloating = (id) => !!layoutHandle.doc()?.nodes?.[topOf(id)]?.float;

  function raise(node) {
    if (layout.floats.at(-1)?.id === node.id) return;
    const float = layoutHandle.doc()?.nodes?.[node.id]?.float;
    if (float) updateLayout((nodes) => Layout.float(nodes, node.id, float));
  }

  // "move", or an edge or corner: "n", "se"…
  function startFloat(event, node, edge) {
    if (event.button !== 0 || !node.float) return;
    event.preventDefault();
    const from = { ...floatBox(node.float), z: node.float.z };
    const sides = edge === "move" ? "" : edge;
    const sx = event.clientX;
    const sy = event.clientY;
    // sized, it stops at the frame's edges, so its own stay in reach
    const frame = frameSize() ?? { w: Infinity, h: Infinity };
    const most = {
      e: Math.max(FLOAT_MIN.w, frame.w - from.x),
      s: Math.max(FLOAT_MIN.h, frame.h - from.y),
      w: Math.max(FLOAT_MIN.w, from.x + from.w),
      n: Math.max(FLOAT_MIN.h, from.y + from.h),
    };
    dragLive(
      event,
      edge,
      (event) => {
        const dx = event.clientX - sx;
        const dy = event.clientY - sy;
        let { x, y, w, h } = from;
        if (edge === "move") {
          x += dx;
          y += dy;
        }
        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
        if (sides.includes("e")) w = clamp(from.w + dx, FLOAT_MIN.w, most.e);
        if (sides.includes("s")) h = clamp(from.h + dy, FLOAT_MIN.h, most.s);
        if (sides.includes("w")) {
          w = clamp(from.w - dx, FLOAT_MIN.w, most.w);
          x = from.x + from.w - w;
        }
        if (sides.includes("n")) {
          h = clamp(from.h - dy, FLOAT_MIN.h, most.n);
          y = from.y + from.h - h;
        }
        const box = floatBox({ x, y, w, h });
        const float = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(w), h: Math.round(h), z: from.z };
        return { [node.id]: { float } };
      },
      (nodes, fields) => Layout.float(nodes, node.id, fields[node.id].float),
    );
  }

  // a tab, out of the tiles: over where it was, a bit smaller
  function floatPanel(panel, groupId) {
    const frame = root.getBoundingClientRect();
    const section = root.querySelector(`[data-group="${CSS.escape(groupId)}"]`);
    const rect = section?.getBoundingClientRect() ?? frame;
    const w = Math.round(Math.min(Math.max(rect.width * 0.8, 320), frame.width));
    const h = Math.round(Math.min(Math.max(rect.height * 0.8, 240), frame.height));
    const x = Math.round(Math.max(0, rect.left - frame.left + (rect.width - w) / 2));
    const y = Math.round(Math.max(0, rect.top - frame.top + (rect.height - h) / 2));
    updateLayout((nodes) => Layout.float(nodes, panel.id, { x, y, w, h }));
    activate(panel.id);
  }

  // a floating tab, back in the tiles: in the pane last used, if that's tiled
  function dockPanel(panel) {
    updateLayout((nodes) => Layout.dock(nodes, panel.id, lastGroupId));
    activate(panel.id);
  }

  // ── the pieces ─────────────────────────────────────────────────────────

  function Node(props) {
    return () =>
      props.node.type === "split"
        ? html`<${Split} node=${props.node} />`
        : html`<${Group} node=${props.node} />`;
  }

  function Split(props) {
    const split = props.node;
    return html`<div class="knitoutjs-split" data-direction=${() => split.direction}>
      <${For} each=${() => split.children}>
        ${(child, index) => [
          () =>
            index() > 0 &&
            html`<div
              class="knitoutjs-resizer"
              role="separator"
              aria-orientation=${() => (split.direction === "row" ? "vertical" : "horizontal")}
              onPointerDown=${(event) => startResize(event, split, index() - 1)}
            ></div>`,
          html`<div class="knitoutjs-cell" style=${() => cellStyle(child, split.direction)}>
            <${Node} node=${child} />
          </div>`,
        ]}
      <//>
    </div>`;
  }

  // a group or split floating over the tiles. its tab bars move it (where
  // there aren't tabs), and its edges size it
  function Float(props) {
    const node = props.node;
    return html`<div
      class="latticework-float"
      data-float=${node.id}
      style=${() => {
        const box = floatBox(node.float);
        return {
          left: `${box.x}px`,
          top: `${box.y}px`,
          width: `${box.w}px`,
          height: `${box.h}px`,
          "z-index": 10 + node.float.z,
        };
      }}
      ref=${(el) => {
        // before anything in it (an editor, say) can keep the pointer to itself
        el.addEventListener("pointerdown", () => raise(node), true);
      }}
      onPointerDown=${(event) => {
        if (event.target.classList?.contains("knitoutjs-tabs")) startFloat(event, node, "move");
      }}
    >
      <${Node} node=${node} />
      ${FLOAT_EDGES.map(
        (edge) => html`<div
          class="latticework-float-edge"
          data-edge=${edge}
          onPointerDown=${(event) => startFloat(event, node, edge)}
        ></div>`,
      )}
    </div>`;
  }

  function Group(props) {
    const group = props.node;
    const active = createMemo(() => activeIn(group));
    let tabs;
    let body;

    // which part of this pane a drag is over: the tab bar (as a tab), a band
    // along an edge (to split), over .js code (to import), or the middle
    function zoneFor(event) {
      const types = event.dataTransfer.types;
      const placing = LAYOUT_TYPES.some((type) => types.includes(type));
      const onTabs = tabs.contains(event.target);
      const rect = body.getBoundingClientRect();
      // over code that docs can be imported into, most of it is for that
      const into = placing ? null : hosts.get(active()?.id)?.el.dropInto;
      const zone = onTabs ? "center" : zoneAt(event, rect, into ? CODE_EDGE : undefined);
      if (zone === "center" && into && !onTabs) {
        const line = into.lineAt(event.clientX, event.clientY);
        if (line) return { zone: "code", lineTop: line.top - rect.top };
      }
      return { zone, lineTop: null };
    }
    dropTargets.set(group.id, zoneFor);
    onCleanup(() => {
      if (dropTargets.get(group.id) === zoneFor) dropTargets.delete(group.id);
    });

    const target = () => (dropTarget()?.groupId === group.id ? dropTarget() : null);
    const zone = () => target()?.zone ?? null;
    const codeLine = () => target()?.lineTop ?? null;

    return html`<section
      class="knitoutjs-group"
      data-group=${group.id}
      onPointerDown=${() => (lastGroupId = group.id)}
    >
      <header class="knitoutjs-tabs" role="tablist" ref=${(el) => (tabs = el)}>
        <${For} each=${() => group.panels}>
          ${(panel) => html`<${Tab} panel=${panel} group=${group} active=${() => active() === panel} />`}
        <//>
        <button
          class="knitoutjs-add"
          title="open a file here, or start a new one"
          aria-label="open a file here, or start a new one"
          onClick=${(event) => openMenu(event, group.id)}
        >
          <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12">
            <path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </header>
      ${() => {
        const panel = active();
        return panel && html`<${Bar} panel=${panel} />`;
      }}
      <div class="knitoutjs-body" ref=${(el) => (body = el)}>
        <${For} each=${() => group.panels}>
          ${(panel) => html`<${Panel} panel=${panel} active=${() => active() === panel} />`}
        <//>
        <${Show} when=${dragging}>
          <div class="knitoutjs-dropzone">
            <div class="knitoutjs-drop-hint" data-zone=${zone}></div>
            <${Show} when=${() => zone() === "code"}>
              <div class="knitoutjs-drop-line" style=${() => ({ top: `${codeLine()}px` })}>
                <span>import here</span>
              </div>
            <//>
          </div>
        <//>
        <${Show} when=${() => notice()?.groupId === group.id}>
          <div class="knitoutjs-notice">${() => notice()?.text}</div>
        <//>
      </div>
    </section>`;
  }

  function Panel(props) {
    const panel = props.panel;
    const info = docInfo(panel.url);
    let flash;

    // a new build of the doc it shows (from here or anyone else) tints it for
    // a moment, so you can see what changed it
    createEffect(
      on(
        () => info.builtAt,
        (builtAt, before) => {
          if (before == null || builtAt === before) return;
          flash?.animate([{ opacity: 0.35 }, { opacity: 0 }], {
            duration: 700,
            easing: "ease-out",
          });
        },
        { defer: true },
      ),
    );

    return html`<div
      class="knitoutjs-panel"
      hidden=${() => !props.active}
      data-colour=${() => docColour(panel.url)}
      data-glow=${() => glow(panel.url)}
      data-shared=${() => (inManyPanes(panel.url) ? "" : undefined)}
      data-stuck=${() => (stuck(panel.url) ? "" : undefined)}
      onPointerEnter=${() => setHovered(panel.url)}
      onPointerLeave=${unhover}
    >
      <${Slot} panel=${panel} />
      <div class="knitoutjs-flash" ref=${(el) => (flash = el)}></div>
    </div>`;
  }

  function Tab(props) {
    const { panel, group } = props;
    const info = docInfo(panel.url);
    const [renaming, setRenaming] = createSignal(false);

    async function rename(name) {
      setRenaming(false);
      name = name.trim();
      if (!name || name === info.name) return;
      (await repo.find(panel.url)).change((doc) => {
        doc.name = name;
        doc.extension = fileExtension({ name });
      });
    }

    function onKeyDown(event) {
      if (event.key === "Enter") rename(event.currentTarget.value);
      if (event.key === "Escape") setRenaming(false);
    }

    return html`<div
      class="knitoutjs-tab"
      role="tab"
      draggable="true"
      aria-selected=${() => String(props.active)}
      data-colour=${() => docColour(panel.url)}
      data-glow=${() => glow(panel.url)}
      data-shared=${() => (inManyPanes(panel.url) ? "" : undefined)}
      title=${() => `${info.name}\ndrag to move it, or onto a pane's edge to split it\ndouble click the name to rename`}
      onClick=${() => showTab(group.id, panel.id)}
      onDragStart=${(event) => {
        event.dataTransfer.setData(PANEL_TYPE, panel.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onPointerEnter=${() => setHovered(panel.url)}
      onPointerLeave=${unhover}
    >
      <span class="knitoutjs-tab-pill">
        <span class="knitoutjs-tab-title">
          <span class="knitoutjs-swatch"></span>
          ${() =>
            renaming()
              ? html`<input
                  class="knitoutjs-rename"
                  value=${info.name}
                  ref=${(el) => queueMicrotask(() => (el.focus(), el.select()))}
                  onKeyDown=${onKeyDown}
                  onBlur=${(event) => rename(event.currentTarget.value)}
                  onClick=${(event) => event.stopPropagation()}
                />`
              : html`<span
                  class="knitoutjs-tab-name"
                  title="double click to rename"
                  onDblClick=${() => setRenaming(true)}
                >
                  ${() => info.name}
                </span>`}
        </span>
        <button
          class="knitoutjs-tab-tool"
          aria-haspopup="menu"
          title="what it's shown with: change it here, or open it with something else in a new tab"
          onClick=${(event) => {
            event.stopPropagation();
            showTab(group.id, panel.id);
            openToolMenu(event, panel, group.id);
          }}
        >
          <span class="knitoutjs-tab-tool-name">${() => toolName(panel)}</span>
          <svg class="knitoutjs-tab-tool-arrow" aria-hidden="true" viewBox="0 0 10 6" width="10" height="6">
            <path d="M0 0h10L5 6z" fill="currentColor" />
          </svg>
        </button>
      </span>
      <button
        class="knitoutjs-close"
        title="close"
        aria-label="close"
        onClick=${(event) => {
          event.stopPropagation();
          updateLayout((nodes) => Layout.remove(nodes, panel.id));
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 10 10" width="10" height="10">
          <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
    </div>`;
  }

  // the line under the tabs: which doc this is, where it came from, and (for
  // a generated .k) how up to date it is
  function Bar(props) {
    const panel = props.panel;
    const info = docInfo(panel.url);
    const [copied, setCopied] = createSignal(false);

    function copy() {
      navigator.clipboard?.writeText(panel.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }

    return html`<div class="knitoutjs-bar">
      <button
        class="knitoutjs-url"
        data-colour=${() => docColour(panel.url)}
        title=${() => `${panel.url} (click to copy)`}
        onClick=${copy}
        onPointerEnter=${() => setHovered(panel.url)}
        onPointerLeave=${unhover}
      >
        <span class="knitoutjs-swatch"></span>
        ${() => (copied() ? [icon("check"), " copied"] : shortUrl(panel.url))}
      </button>
      ${() =>
        info.copyOf &&
        html`<button
          class="knitoutjs-link"
          title="open the .k this is a copy of"
          onClick=${() => reveal(info.copyOf, panel.id, "left")}
          data-colour=${docColour(info.copyOf)}
          onPointerEnter=${() => setHovered(info.copyOf)}
          onPointerLeave=${unhover}
        >
          copy of
          <span class="knitoutjs-swatch"></span>
          <span class="knitoutjs-link-name">${() => docInfo(info.copyOf).name}</span>
        </button>`}
      ${() =>
        info.source &&
        html`<button
          class="knitoutjs-link"
          title="open the .js that wrote this"
          onClick=${() => reveal(info.source, panel.id, "left")}
          data-colour=${docColour(info.source)}
          data-stale=${() => (docInfo(info.source).target === panel.url ? undefined : "")}
          onPointerEnter=${() => setHovered(info.source)}
          onPointerLeave=${unhover}
        >
          ${() => (docInfo(info.source).target === panel.url ? "written by" : "last written by")}
          <span class="knitoutjs-swatch"></span>
          <span class="knitoutjs-link-name">${() => docInfo(info.source).name}</span>
        </button>`}
      <span class="knitoutjs-spacer"></span>
      <${BuildStatus} panel=${panel} />
    </div>`;
  }

  // a generated .k's line: built just now, out of date, or its .js failed,
  // only while its .js still writes into it. a .js's says when it failed
  function BuildStatus(props) {
    const panel = props.panel;
    const info = docInfo(panel.url);
    const jsUrl = () => info.source ?? panel.url;
    const build = () => builds[jsUrl()] ?? {};

    function state() {
      if (!info.source) return build().state === "error" ? "error" : null;
      return buildState(panel.url);
    }

    return html`<${Show} when=${state}>
      <span class="knitoutjs-build-status" data-state=${state}>
        ${() => {
          switch (state()) {
            case "running":
              return "building…";
            case "error":
              return html`<button
                class="knitoutjs-error-line"
                title=${() => `${build().message ?? ""}\n${info.source ? "show the .js, at that line" : "go to that line"}`}
                onClick=${() => showError(jsUrl(), panel.id)}
              >
                ${icon("warning")}
                ${() => (build().line != null ? `error on line ${build().line}` : "error")}
              </button>`;
            case "stale":
              // an array: html`` drops text before an element at the top
              return [
                "out of date —",
                html`<button
                  class="knitoutjs-rebuild"
                  title="build it again from its .js"
                  onClick=${() => rebuild(info.source, panel.url)}
                >
                  ${icon("rebuild")} rebuild
                </button>`,
              ];
            default:
              return () => (info.builtAt ? `generated ${ago(info.builtAt, clock())}` : "generated");
          }
        }}
      </span>
    <//>`;
  }

  function Empty() {
    return html`<div class="knitoutjs-empty">
      <div class="knitoutjs-empty-card">
        <h2 class="knitoutjs-rough">nothing's open</h2>
        <p>drag a .js, a .k, or anything else in from the files, or</p>
        <div class="knitoutjs-empty-actions">
          <button class="knitoutjs-button" onClick=${() => newPattern()}>
            ${icon("plus")} new pattern
          </button>
          <button class="knitoutjs-button" onClick=${(event) => openMenu(event, null)}>
            ${icon("folder")} open…
          </button>
        </div>
        <${Show} when=${() => notice() && !notice().groupId}>
          <p class="knitoutjs-empty-notice">${() => notice()?.text}</p>
        <//>
      </div>
    </div>`;
  }

  function Menu() {
    const item = (name, label, detail, onClick) => html`<button
      class="knitoutjs-menu-item"
      onClick=${onClick}
    >
      ${icon(name)}
      ${label}
      <small>${detail}</small>
    </button>`;

    return html`<div
      class="knitoutjs-menu"
      popover="auto"
      ref=${(el) => (menu = el)}
      onToggle=${(event) => event.newState === "closed" && setMenuFor(null)}
    >
      <div class="knitoutjs-menu-heading">new</div>
      ${item("plus", "pattern", "a .js and the .k it writes", fromMenu(() => newPattern()))}
      ${item("file", ".js file", "", fromMenu((groupId) => newFile(groupId, "untitled.knitout.js")))}
      ${item("file", ".k file", "", fromMenu((groupId) => newFile(groupId, "untitled.k")))}
      ${item("text", "markdown", "", fromMenu((groupId) => newDoc(groupId, "markdown")))}
      ${extraItems.map(
        (extra) => html`<${Show} when=${() => !extra.alt || altHeld()}>
          ${item(extra.icon, extra.label, extra.detail ?? "", fromMenu((groupId) => newExtra(groupId, extra)))}
        <//>`,
      )}
      <div class="knitoutjs-menu-heading">in this project</div>
      <${For}
        each=${() => projectFiles()}
        fallback=${html`<div class="knitoutjs-menu-empty">nothing yet</div>`}
      >
        ${(file) => html`<button
          class="knitoutjs-menu-item knitoutjs-menu-file"
          data-colour=${docColour(file.url)}
          onClick=${fromMenu((groupId) => openDocs([file.url], groupId))}
          onPointerEnter=${() => setHovered(file.url)}
          onPointerLeave=${unhover}
        >
          <span class="knitoutjs-swatch"></span>
          ${file.name}
        </button>`}
      <//>
      <form class="knitoutjs-menu-url" onSubmit=${onOpenUrl}>
        <input
          name="url"
          placeholder="automerge:… url"
          autocomplete="off"
          onInput=${(event) => event.currentTarget.setCustomValidity("")}
        />
      </form>
      <p class="knitoutjs-menu-hint">or drag anything in from the files</p>
    </div>`;
  }

  function ToolMenu() {
    const tools = () => {
      const panel = toolMenuFor()?.panel;
      return panel ? toolChoices(panel.url) : [];
    };
    const isChosen = (tool) => {
      const panel = toolMenuFor()?.panel;
      const chosen = panel && shownWith(panel);
      return !!chosen && chosen.tool === tool.tool && chosen.patchworkTool === tool.patchworkTool;
    };

    function choose(tool) {
      const { panel } = toolMenuFor();
      toolMenu.hidePopover();
      updateLayout((nodes) => Layout.setTool(nodes, panel.id, tool.tool, tool.patchworkTool));
    }

    function openInNewTab(tool) {
      const { panel, groupId } = toolMenuFor();
      toolMenu.hidePopover();
      const [made] = updateLayout((nodes) =>
        Layout.openPanels(nodes, groupId, "center", [
          Layout.newPanel(panel.url, tool.tool, tool.patchworkTool),
        ]),
      );
      activate(made);
    }

    return html`<div
      class="knitoutjs-menu knitoutjs-tool-menu"
      popover="auto"
      role="menu"
      ref=${(el) => (toolMenu = el)}
      onToggle=${(event) => event.newState === "closed" && setToolMenuFor(null)}
    >
      <div class="knitoutjs-menu-heading">show with</div>
      <${For} each=${tools}>
        ${(tool) => html`<div class="knitoutjs-tool-option">
          <button
            class="knitoutjs-menu-item"
            role="menuitemradio"
            aria-checked=${() => String(isChosen(tool))}
            title=${`${tool.title}\nclick to show it with this here, or drag it to a tab bar or a pane's edge to open it there too`}
            draggable="true"
            onClick=${() => choose(tool)}
            onDragStart=${(event) => {
              event.dataTransfer.setData(
                TOOL_TYPE,
                JSON.stringify({
                  url: toolMenuFor().panel.url,
                  id: tool.tool,
                  patchworkTool: tool.patchworkTool,
                }),
              );
              event.dataTransfer.effectAllowed = "copy";
            }}
          >
            ${tool.name}
          </button>
          <button
            class="knitoutjs-open-new"
            title=${`open it with ${tool.name} in a new tab`}
            aria-label=${`open it with ${tool.name} in a new tab`}
            onClick=${() => openInNewTab(tool)}
          >
            ${icon("open-new", 12)}
          </button>
        </div>`}
      <//>
      <div class="latticework-menu-rule" role="separator"></div>
      <button
        class="knitoutjs-menu-item"
        role="menuitem"
        onClick=${() => {
          const { panel, groupId } = toolMenuFor();
          toolMenu.hidePopover();
          if (isFloating(panel.id)) dockPanel(panel);
          else floatPanel(panel, groupId);
        }}
      >
        ${() => {
          const panel = toolMenuFor()?.panel;
          return panel && isFloating(panel.id) ? "dock" : "float";
        }}
      </button>
    </div>`;
  }

  // a file from the list: brought forward if it's showing, else opened in
  // the pane last used
  function open(url) {
    const showing = findShowing(url);
    if (showing) {
      showTab(showing.group.id, showing.panel.id);
      flashDoc(url);
    } else {
      openDocs([url], null);
    }
  }

  // taking a file out of the project: it's forgotten and its panes close.
  // the doc itself is still there for anything else that links to it
  function removeFile(url) {
    files.remove(url);
    updateLayout((nodes) => {
      for (const id of Object.keys(nodes)) {
        if (nodes[id]?.type === "panel" && nodes[id].url === url) Layout.remove(nodes, id);
      }
    });
  }

  // removing asks twice: the first press arms it for a few seconds
  const [removing, setRemoving] = createSignal(null);
  let removingTimer;
  function askToRemove(url) {
    clearTimeout(removingTimer);
    if (removing() === url) {
      setRemoving(null);
      removeFile(url);
      return;
    }
    setRemoving(url);
    removingTimer = setTimeout(() => setRemoving(null), 3000);
  }

  // the project's files as a family tree. a .k is under the .js that writes
  // it now. one that .js used to write, and an editable copy, are files of
  // their own (at the top), with a ghost of them where they came from: under
  // that .js, or the .k they copy. [{url, name, extension, depth, last,
  // parent, trail, ghost}]: `last` among its siblings, `parent` of the rows
  // under it, `trail`, for each of its ancestors below the top, whether that
  // one has more siblings below (so its line carries on past this row), and
  // `ghost`, "written" or "copied" for a ghost (it has no rows of its own)
  const fileTree = createMemo(() => {
    const list = projectFiles();
    const inProject = new Set(list.map((file) => file.url));
    const children = new Map();
    const addChild = (parent, file, ghost) => {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push({ file, ghost });
    };
    const roots = [];
    for (const file of list) {
      const info = docInfo(file.url);
      const writer = info.source !== file.url && inProject.has(info.source) ? info.source : null;
      const writtenNow = !!writer && docInfo(writer).target === file.url;
      if (writer) addChild(writer, file, writtenNow ? false : "written");
      if (info.copyOf !== file.url && inProject.has(info.copyOf)) addChild(info.copyOf, file, "copied");
      if (!writtenNow) roots.push(file);
    }
    // its own children first, then the ghosts
    for (const kids of children.values()) kids.sort((a, b) => !!a.ghost - !!b.ghost);

    const rows = [];
    const seen = new Set();
    const visit = (file, depth, trail = [], last = true, ghost = false) => {
      if (!ghost) {
        if (seen.has(file.url)) return;
        seen.add(file.url);
      }
      const kids = ghost
        ? []
        : (children.get(file.url) ?? []).filter((kid) => kid.ghost || !seen.has(kid.file.url));
      rows.push({ ...file, depth, trail, last, ghost, parent: kids.length > 0 });
      const kidsTrail = depth ? [...trail, !last] : [];
      kids.forEach((kid, i) =>
        visit(kid.file, depth + 1, kidsTrail, i === kids.length - 1, kid.ghost),
      );
    };
    for (const file of roots) visit(file, 0);
    // files whose parents lead round in a circle
    for (const file of list) visit(file, 0);
    return rows;
  });

  // "built 3 min ago", "edited just now"
  function lastTouched(url) {
    const info = docInfo(url);
    if (info.builtAt) return `built ${ago(info.builtAt, clock())}`;
    if (info.editedAt) return `edited ${ago(info.editedAt, clock())}`;
    return "";
  }

  // the dotted lines joining a row of the tree to its parent and children
  function guides(file) {
    const line = (kind, at) =>
      html`<span class=${`lattice-guide ${kind}`} style=${{ "--at": at }}></span>`;
    return [
      ...file.trail.map((carriesOn, at) => carriesOn && line("", at)),
      file.depth > 0 && line(file.last ? "lattice-guide-last" : "lattice-guide-tee", file.depth - 1),
      file.parent && line("lattice-guide-down", file.depth),
    ].filter(Boolean);
  }

  // the project's files, down the side of its panes
  function Files() {
    return html`<nav
      class="lattice-files"
      aria-label="files"
      style=${() => ({ width: `${filesSidebar.width()}px` })}
    >
      <${Resizer} sidebar=${filesSidebar} />
      <div class="lattice-sidebar-content">
        <header class="lattice-files-heading">
          <span class="lattice-path" title=${() => projectName()}>${projectName}</span>
          <button
            class="lattice-icon-button"
            title="a new file, or open one (hold alt for more)"
            aria-label="a new file, or open one"
            onClick=${(event) => openMenu(event, null)}
          >
            ${icon("plus", 14)}
          </button>
        </header>
        <${For}
          each=${fileTree}
          fallback=${html`<p class="lattice-files-empty">no files yet</p>`}
        >
          ${(file) => html`<div
            class="lattice-file"
            data-colour=${docColour(file.url)}
            style=${{ "--depth": file.depth }}
            data-ghost=${file.ghost || undefined}
            data-showing=${() => (!file.ghost && findShowing(file.url) ? "" : undefined)}
            data-removing=${() => (removing() === file.url ? "" : undefined)}
            draggable="true"
            onDragStart=${(event) => {
              event.dataTransfer.setData(
                "text/x-patchwork-dnd",
                JSON.stringify({ items: [{ url: file.url, name: file.name }] }),
              );
              event.dataTransfer.effectAllowed = "copy";
            }}
            onPointerEnter=${() => setHovered(file.url)}
            onPointerLeave=${unhover}
          >
            ${guides(file)}
            <button
              class="lattice-file-open"
              title=${() =>
                file.ghost === "written"
                  ? `${file.name} used to be written by this. click to open it`
                  : file.ghost === "copied"
                    ? `${file.name} is a copy of this. click to open it`
                    : `${file.name}\nclick to open it, or drag it onto a pane`}
              onClick=${() => open(file.url)}
              onKeyDown=${(event) => {
                if (!file.ghost && (event.key === "Delete" || event.key === "Backspace")) {
                  askToRemove(file.url);
                }
              }}
            >
              <span class="knitoutjs-swatch"></span>
              <span class="lattice-file-name">${() => file.name}</span>
            </button>
            ${!file.ghost &&
            html`<span class="lattice-file-when">${() => lastTouched(file.url)}</span>
              <button
                class="lattice-file-remove"
                aria-label=${() => `remove ${file.name} from ${projectName()}`}
                title=${() =>
                  removing() === file.url
                    ? "click again to remove it"
                    : `remove it from ${projectName()} (the doc itself stays)`}
                onClick=${() => askToRemove(file.url)}
              >
                ${() => (removing() === file.url ? "remove?" : icon("close", 12))}
              </button>`}
          </div>`}
        <//>
      </div>
    </nav>`;
  }

  // the files, shut, when nothing else opens them: a strip to open them
  function FilesShut() {
    return html`<button
      class="latticework-files-shut"
      title="show the files"
      onClick=${() => filesSidebar.setOpen(true)}
    >
      files
    </button>`;
  }

  onOpen?.(open);

  // what each pane is showing: its active panel's doc
  function showing() {
    const docs = [];
    for (const group of allGroups()) {
      const panel = activeIn(group);
      if (panel && !docs.some((doc) => doc.url === panel.url)) {
        docs.push({ url: panel.url, name: docInfo(panel.url).name });
      }
    }
    return docs;
  }

  const dispose = render(() => {
    createEffect(() => onShowing?.(showing()));
    return html`<link
        rel="stylesheet"
        href=${STYLESHEET}
        onLoad=${() => setStyled(true)}
        onError=${() => setStyled(true)}
      />
      <div
        class="knitoutjs-editor-tool lattice-project"
        style=${() => (styled() ? {} : { visibility: "hidden" })}
      >
        <${Show} when=${filesSidebar.open} fallback=${sidebar ? null : html`<${FilesShut} />`}>
          <${Files} />
        <//>
        <div
          class="knitoutjs-editor-tool knitoutjs-frame"
          ref=${(el) => {
            root = el;
            listenForDrops(el);
            frameObserver.observe(el);
          }}
          data-resizing=${resizing}
        >
          <svg class="knitoutjs-defs" aria-hidden="true">
            <filter id="knitoutjs-rough-1">
              <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="1" />
              <feDisplacementMap in="SourceGraphic" scale="1.4" />
            </filter>
            <filter id="knitoutjs-rough-2">
              <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="2" />
              <feDisplacementMap in="SourceGraphic" scale="1.4" />
            </filter>
            <filter id="knitoutjs-rough-3">
              <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="3" />
              <feDisplacementMap in="SourceGraphic" scale="1.4" />
            </filter>
          </svg>
          ${() => (layout.root ? html`<${Node} node=${layout.root} />` : html`<${Empty} />`)}
          <${For} each=${() => layout.floats}>${(node) => html`<${Float} node=${node} />`}<//>
          <${Show} when=${outerZone}>
            <div class="knitoutjs-outer-hint" data-zone=${outerZone}></div>
          <//>
          <${Menu} />
          <${ToolMenu} />
        </div>
      </div>`;
  }, element);

  return function unmount() {
    layoutHandle.off("change", readLayout);
    layoutHandle.off("ephemeral-message", onDragMessage);
    tabChannel.close();
    frameObserver.disconnect();
    clearTimeout(lapse);
    clearTimeout(sendTimer);
    offFiles();
    document.removeEventListener("dragover", onDocumentDragOver);
    document.removeEventListener("dragend", stopDragging);
    document.removeEventListener("drop", stopDragging);
    document.removeEventListener("keydown", onAltKey);
    document.removeEventListener("keyup", onAltKey);
    clearTimeout(noticeTimer);
    clearTimeout(removingTimer);
    clearInterval(ticker);
    offPatchworkTools();
    for (const [id, host] of hosts) destroyHost(id, host);
    for (const { off } of infos.values()) off?.();
    dispose();
  };
}
