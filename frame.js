import { createSignal, createMemo, createEffect, on, onCleanup, For, Show } from "solid-js";
import { createStore, reconcile, produce, unwrap } from "solid-js/store";
import { render } from "solid-js/web";
import html from "solid-js/html";
import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import {
  getFallbackTool,
  getRegistry,
  getSupportedToolsForType,
} from "@inkandswitch/patchwork-plugins";
import {
  TOOLS,
  toolsFor,
  fileExtension,
  docColour,
  docText,
  shortUrl,
  newFileDoc,
  textHash,
} from "./files.js";
import {
  findNode,
  findPanel,
  findPanelShowing,
  newPanel,
  newGroup,
  newSplit,
  addRow,
  openPanels,
  movePanel,
  removePanel,
  setTool,
  activate,
} from "./layout.js";
import defaultSource from "./default-source.js";
import { builds, setBuild } from "./builds.js";

const STYLESHEET = new URL("./frame.css", import.meta.url).href;

async function loadDatatype(type) {
  if (!type || type === "file") return undefined;
  try {
    return await getRegistry("patchwork:datatype").load(type);
  } catch {
    return undefined;
  }
}

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

const MIN_CELL = 80;
const EDGE = 0.22;
const MAX_EDGE = 64;
const CODE_EDGE = 28;
const OUTER_EDGE = 10;

// what can be dragged in: our own tabs, the tools in a tab's tool menu (to
// open that file with that tool somewhere else), and docs from the sidebar
const PANEL_TYPE = "application/x-knitoutjs-panel";
const TOOL_TYPE = "application/x-knitoutjs-tool";
// drags that place a pane, rather than bring a doc in
const LAYOUT_TYPES = [PANEL_TYPE, TOOL_TYPE];
const DOC_TYPES = [
  "text/x-patchwork-dnd",
  "text/x-patchwork-urls",
  "text/uri-list",
];

function isOurDrag(dataTransfer) {
  return [...LAYOUT_TYPES, ...DOC_TYPES].some((type) =>
    dataTransfer?.types.includes(type),
  );
}

function urlFromText(text) {
  const trimmed = text.trim();
  if (isValidAutomergeUrl(trimmed)) return trimmed;
  // patchwork links carry the document id as #doc=<id>
  const id = trimmed.match(/#doc=([^&\s]+)/)?.[1];
  return id && isValidAutomergeUrl(`automerge:${id}`) ? `automerge:${id}` : null;
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

export default function KnitoutFrameTool(handle, element) {
  const repo = element.repo;

  let root;
  let menu;

  // ── what's in the project doc ──────────────────────────────────────────

  const [layout, setLayout] = createStore({ root: null });
  const [fileUrls, setFileUrls] = createSignal([]);

  function readDoc() {
    const doc = handle.doc();
    const tree = doc?.layout ? JSON.parse(JSON.stringify(doc.layout)) : null;
    setLayout("root", reconcile(tree, { key: "id" }));
    setFileUrls([...(doc?.files ?? [])]);
  }
  readDoc();
  handle.on("change", readDoc);

  function updateLayout(change) {
    const next = change(structuredClone(unwrap(layout.root) ?? null));
    handle.change((doc) => {
      doc.layout = next ?? null;
    });
  }

  function addFiles(urls) {
    handle.change((doc) => {
      doc.files ??= [];
      for (const url of urls) if (!doc.files.includes(url)) doc.files.push(url);
    });
  }

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
  // .js wrote it last, but that's history, so it doesn't light up)
  // (and a .k and its editable copy)
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

  // a doc open in more than one pane is marked out in each, in its colour
  const paneCounts = createMemo(() => {
    const counts = new Map();
    (function count(node) {
      if (!node) return;
      if (node.type === "split") return node.children.forEach(count);
      for (const url of new Set(node.panels.map((panel) => panel.url))) {
        counts.set(url, (counts.get(url) ?? 0) + 1);
      }
    })(layout.root);
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
    const showing = findPanelShowing(layout.root, url);
    if (showing) {
      const { group, index } = showing;
      updateLayout((tree) => activate(tree, group.id, group.panels[index].id));
    } else {
      const doc = (await repo.find(url)).doc();
      const tool = toolId ?? toolsFor(fileExtension(doc))[0].id;
      const from = findPanel(layout.root, fromPanelId)?.group.id ?? null;
      addFiles([url]);
      updateLayout((tree) => openPanels(tree, from, edge, [newPanel(url, tool)]));
    }
    setHovered(url);
    setTimeout(() => hovered() === url && setHovered(null), 900);
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
    open: (url, toolElement, edge) => reveal(url, panelOf(toolElement), edge),
    openIfClosed: (url, toolElement, edge) =>
      findPanelShowing(layout.root, url) || reveal(url, panelOf(toolElement), edge),
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

  async function mountTool(host) {
    try {
      const [docHandle, module] = await Promise.all([
        repo.find(host.url),
        TOOLS[host.tool].load(),
      ]);
      if (host.dead) return;
      host.cleanup = module.default(docHandle, host.el, {
        ...toolContext,
        toolId: host.patchworkTool,
      });
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

  async function openDocs(urls, groupId, zone = "center") {
    const panels = [];
    const refused = [];
    for (const url of urls) {
      try {
        const doc = (await repo.find(url)).doc();
        panels.push(newPanel(url, toolsFor(fileExtension(doc))[0].id));
      } catch {
        refused.push(shortUrl(url));
      }
    }
    if (panels.length) {
      addFiles(panels.map((panel) => panel.url));
      updateLayout((tree) => openPanels(tree, groupId, zone, panels));
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
    const row = newSplit("row", [
      newGroup([newPanel(js, "editor")]),
      newGroup([newPanel(k, "visualizer")]),
    ]);
    updateLayout((tree) => addRow(tree, row));
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

  const [menuFor, setMenuFor] = createSignal(null);

  function openMenu(event, groupId) {
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

  // the one patchwork would pick first. not frames (this one included: it's
  // for knitout projects, but not inside a pane of itself)
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
          tool.id !== "knitoutjs-panes",
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
  // it: {groupId, zone, lineTop}. the panes only show this; the frame works
  // it out, at its root, so nothing inside a pane (an editor, a canvas) can
  // take the drop first
  const [dropTarget, setDropTarget] = createSignal(null);
  const dropTargets = new Map(); // group id → (event) => {zone, lineTop}

  // browsers often leave dragleave's relatedTarget empty, so count instead:
  // every element entered is left again
  let entered = 0;

  // the drop effect to answer with, for what's being dragged
  function dropEffectFor(dataTransfer) {
    const types = dataTransfer.types;
    if (types.includes(PANEL_TYPE)) return "move";
    return "copy";
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
    if (!layout.root) return { groupId: null, zone: "center" };
    const section = event.target.closest?.(".knitoutjs-group");
    const zoneFor = section && dropTargets.get(section.dataset.group);
    return zoneFor ? { groupId: section.dataset.group, ...zoneFor(event) } : null;
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
    const group = target.groupId && findNode(layout.root, target.groupId);
    const active = group?.panels?.find((panel) => panel.id === group.active) ?? group?.panels?.[0];
    drop(event, target.groupId, target.zone, active);
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
      updateLayout((tree) => movePanel(tree, panelId, groupId, zone));
      return;
    }
    const tool = dataTransfer.getData(TOOL_TYPE);
    if (tool) {
      const { url, id, patchworkTool } = JSON.parse(tool);
      const at = zone === "code" ? "center" : zone;
      updateLayout((tree) => openPanels(tree, groupId, at, [newPanel(url, id, patchworkTool)]));
      return;
    }
    const docs = droppedDocs(dataTransfer);
    if (zone === "code") {
      hosts.get(activePanel.id)?.el.dropInto?.drop(docs, event.clientX, event.clientY);
      return;
    }
    openDocs(docs.map((doc) => doc.url), groupId, zone);
  }

  // ── resizing splits (flex-basis, committed when you let go) ─────────────

  const [resizing, setResizing] = createSignal(null);

  function startResize(event, splitId, left) {
    const resizer = event.currentTarget;
    const box = resizer.parentElement.getBoundingClientRect();
    const split = findNode(layout.root, splitId);
    const row = split.direction === "row";
    resizer.setPointerCapture(event.pointerId);
    setResizing(row ? "row" : "column");

    const start = row ? event.clientX : event.clientY;
    const length = row ? box.width : box.height;
    const sizes = [...split.sizes];
    const pair = sizes[left] + sizes[left + 1];
    const min = Math.min((MIN_CELL / length) * 100, pair / 2);

    function onMove(event) {
      const delta = (((row ? event.clientX : event.clientY) - start) / length) * 100;
      const size = Math.min(Math.max(sizes[left] + delta, min), pair - min);
      setLayout(
        produce((state) => {
          const node = findNode(state.root, splitId);
          node.sizes[left] = size;
          node.sizes[left + 1] = pair - size;
        }),
      );
    }

    function onUp() {
      setResizing(null);
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
      resizer.removeEventListener("pointercancel", onUp);
      updateLayout((tree) => tree);
    }

    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
    resizer.addEventListener("pointercancel", onUp);
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
              onPointerDown=${(event) => startResize(event, split.id, index() - 1)}
            ></div>`,
          html`<div
            class="knitoutjs-cell"
            style=${() => ({
              "flex-basis": `${split.sizes[index()] ?? 100 / split.children.length}%`,
            })}
          >
            <${Node} node=${child} />
          </div>`,
        ]}
      <//>
    </div>`;
  }

  function Group(props) {
    const group = props.node;
    const active = createMemo(
      () => group.panels.find((panel) => panel.id === group.active) ?? group.panels[0],
    );
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
    >
      <header class="knitoutjs-tabs" role="tablist" ref=${(el) => (tabs = el)}>
        <${For} each=${() => group.panels}>
          ${(panel) => html`<${Tab} panel=${panel} group=${group} active=${() => active() === panel} />`}
        <//>
        <button
          class="knitoutjs-add"
          title="open a file here, or start a new pattern"
          onClick=${(event) => openMenu(event, group.id)}
        >
          +
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
      onClick=${() => updateLayout((tree) => activate(tree, group.id, panel.id))}
      onDragStart=${(event) => {
        event.dataTransfer.setData(PANEL_TYPE, panel.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onPointerEnter=${() => setHovered(panel.url)}
      onPointerLeave=${unhover}
    >
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
      <button
        class="knitoutjs-tab-tool"
        aria-haspopup="menu"
        title="what it's shown with: change it here, or open it with something else in a new tab"
        onClick=${(event) => {
          event.stopPropagation();
          updateLayout((tree) => activate(tree, group.id, panel.id));
          openToolMenu(event, panel, group.id);
        }}
      >
        ${() => toolName(panel)}
        <span aria-hidden="true">▾</span>
      </button>
      <button
        class="knitoutjs-close"
        title="close"
        onClick=${(event) => {
          event.stopPropagation();
          updateLayout((tree) => removePanel(tree, panel.id));
        }}
      >
        ×
      </button>
    </div>`;
  }

  // the line under the tabs: which doc this is, where it came from, and
  // (for a generated .k) how up to date it is
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
        ${() => (copied() ? "copied" : shortUrl(panel.url))}
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

  // a generated .k's line: built just now, out of date, or its .js failed.
  // only while its .js still writes into it
  function BuildStatus(props) {
    const panel = props.panel;
    const info = docInfo(panel.url);
    const source = () => (info.source ? docInfo(info.source) : null);
    const build = () => builds[info.source] ?? {};
    const outOfDate = () =>
      !!info.sourceHash && !!source()?.textHash && info.sourceHash !== source().textHash;

    function state() {
      if (source()?.target !== panel.url) return null;
      if (build().state === "running") return "running";
      if (build().state === "error") return "error";
      // with autobuild on, it's about to build anyway
      if (outOfDate()) return build().auto && build().builder ? "running" : "stale";
      return "built";
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
                title=${() => `${build().message ?? ""}\nshow the .js, at that line`}
                onClick=${() => showError(info.source, panel.id)}
              >
                ${() => (build().line != null ? `⚠ error on line ${build().line}` : "⚠ error")}
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
                  rebuild
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
        <p>drag a .js, a .k, or anything else in from the sidebar, or</p>
        <div class="knitoutjs-empty-actions">
          <button class="knitoutjs-button" onClick=${() => newPattern()}>
            new pattern
          </button>
          <button class="knitoutjs-button" onClick=${(event) => openMenu(event, null)}>
            open…
          </button>
        </div>
        <${Show} when=${() => notice() && !notice().groupId}>
          <p class="knitoutjs-empty-notice">${() => notice()?.text}</p>
        <//>
      </div>
    </div>`;
  }

  function Menu() {
    const item = (label, detail, onClick) => html`<button
      class="knitoutjs-menu-item"
      onClick=${onClick}
    >
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
      ${item("pattern", "a .js and the .k it writes", fromMenu(newPattern))}
      ${item(".js file", "", fromMenu((groupId) => newFile(groupId, "untitled.knitout.js")))}
      ${item(".k file", "", fromMenu((groupId) => newFile(groupId, "untitled.k")))}
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
      <p class="knitoutjs-menu-hint">or drag anything in from the sidebar</p>
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
      updateLayout((tree) => setTool(tree, panel.id, tool.tool, tool.patchworkTool));
    }

    function openInNewTab(tool) {
      const { panel, groupId } = toolMenuFor();
      toolMenu.hidePopover();
      updateLayout((tree) =>
        openPanels(tree, groupId, "center", [newPanel(panel.url, tool.tool, tool.patchworkTool)]),
      );
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
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v3.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>`}
      <//>
    </div>`;
  }

  const dispose = render(
    () =>
      html`<link rel="stylesheet" href=${STYLESHEET} />
        <div
          class="knitoutjs-editor-tool knitoutjs-frame"
          ref=${(el) => {
            root = el;
            listenForDrops(el);
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
          <${Show} when=${outerZone}>
            <div class="knitoutjs-outer-hint" data-zone=${outerZone}></div>
          <//>
          <${Menu} />
          <${ToolMenu} />
        </div>`,
    element,
  );

  return () => {
    handle.off("change", readDoc);
    document.removeEventListener("dragover", onDocumentDragOver);
    document.removeEventListener("dragend", stopDragging);
    document.removeEventListener("drop", stopDragging);
    clearTimeout(noticeTimer);
    clearInterval(ticker);
    offPatchworkTools();
    for (const [id, host] of hosts) destroyHost(id, host);
    for (const { off } of infos.values()) off?.();
    dispose();
  };
}
