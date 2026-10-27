import { createSignal, createMemo, createEffect, onCleanup, For, Show } from "solid-js";
import { createStore, reconcile, produce, unwrap } from "solid-js/store";
import { render } from "solid-js/web";
import html from "solid-js/html";
import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import {
  TOOLS,
  toolsFor,
  canOpen,
  fileExtension,
  docColour,
  shortUrl,
  newFileDoc,
} from "./files.js";
import {
  findNode,
  findPanel,
  newPanel,
  openPanels,
  movePanel,
  removePanel,
  setTool,
  activate,
} from "./layout.js";
import defaultSource from "./default-source.js";

const STYLESHEET = new URL("./frame.css", import.meta.url).href;
const MIN_CELL = 80;
const EDGE = 0.22;

// what can be dragged in: our own tabs, and docs from the patchwork sidebar
const PANEL_TYPE = "application/x-knitoutjs-panel";
const DOC_TYPES = [
  "text/x-patchwork-dnd",
  "text/x-patchwork-urls",
  "text/uri-list",
];

function isOurDrag(dataTransfer) {
  return [PANEL_TYPE, ...DOC_TYPES].some((type) =>
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

// which part of a group the pointer is over: an edge to split, or the middle
function zoneAt(event, rect) {
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const nearest = Math.min(x, 1 - x, y, 1 - y);
  if (nearest > EDGE) return "center";
  if (nearest === x) return "left";
  if (nearest === 1 - x) return "right";
  if (nearest === y) return "top";
  return "bottom";
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
      });
      entry = { info, off: null };
      infos.set(url, entry);
      repo
        .find(url)
        .then((docHandle) => {
          const update = () => {
            const doc = docHandle.doc();
            setInfo({
              name: doc?.name || shortUrl(url),
              extension: fileExtension(doc),
              target: doc?.knitoutTarget ?? null,
              source: doc?.knitoutSource ?? null,
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

  function linked(a, b) {
    const one = docInfo(a);
    const two = docInfo(b);
    return (
      one.target === b || one.source === b || two.target === a || two.source === a
    );
  }

  function glow(url) {
    const lit = hovered();
    if (!lit || !url) return undefined;
    if (lit === url) return "same";
    return linked(lit, url) ? "linked" : undefined;
  }

  const hoverProps = (url) => ({
    onPointerEnter: () => setHovered(url),
    onPointerLeave: () => setHovered(null),
  });

  // ── tools: each panel's tool lives in its own element, which moves with
  //    the panel when the layout changes rather than starting over

  const toolContext = {
    repo,
    get events() {
      return root;
    },
    project: { files: projectFiles, createFile },
    hover: setHovered,
  };

  const hosts = new Map();

  function hostFor(panel) {
    const { id, url, tool } = panel;
    let host = hosts.get(id);
    if (host && host.url === url && host.tool === tool) return host;
    if (host) destroyHost(id, host);
    host = { url, tool, el: document.createElement("div"), cleanup: null };
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
      host.cleanup = module.default(docHandle, host.el, toolContext);
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
        const tools = toolsFor(fileExtension(doc));
        if (tools.length) panels.push(newPanel(url, tools[0].id));
        else refused.push(doc?.name || shortUrl(url));
      } catch {
        refused.push(shortUrl(url));
      }
    }
    if (panels.length) {
      addFiles(panels.map((panel) => panel.url));
      updateLayout((tree) => openPanels(tree, groupId, zone, panels));
    }
    if (refused.length) {
      notify(groupId, `only .js and .k files open here, not ${refused.join(", ")}`);
    }
  }

  async function newPattern(groupId) {
    const k = await createFile("pattern.k");
    const js = await createFile("pattern.knitout.js", {
      content: defaultSource,
      knitoutTarget: k,
    });
    const jsPanel = newPanel(js, "editor");
    updateLayout((tree) => {
      tree = openPanels(tree, groupId, "center", [jsPanel]);
      const beside = findPanel(tree, jsPanel.id).group.id;
      return openPanels(tree, beside, "right", [newPanel(k, "visualizer")]);
    });
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

  function onRootDragEnter(event) {
    if (isOurDrag(event.dataTransfer)) setDragging(true);
  }
  function onRootDragLeave(event) {
    if (!root.contains(event.relatedTarget)) setDragging(false);
  }
  const stopDragging = () => setDragging(false);
  document.addEventListener("dragend", stopDragging);
  document.addEventListener("drop", stopDragging);

  function drop(event, groupId, zone, activePanel) {
    event.preventDefault();
    setDragging(false);
    const dataTransfer = event.dataTransfer;
    const panelId = dataTransfer.getData(PANEL_TYPE);
    if (panelId) {
      updateLayout((tree) => movePanel(tree, panelId, groupId, zone));
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
    const [zone, setZone] = createSignal(null);
    const [codeLine, setCodeLine] = createSignal(null);
    let tabs;
    let body;

    function onDragOver(event) {
      if (!isOurDrag(event.dataTransfer)) return;
      event.preventDefault();
      const isPanel = event.dataTransfer.types.includes(PANEL_TYPE);
      const onTabs = tabs.contains(event.target);
      const rect = body.getBoundingClientRect();
      let next = onTabs ? "center" : zoneAt(event, rect);
      let line = null;
      if (next === "center" && !isPanel && !onTabs) {
        line = hosts.get(active()?.id)?.el.dropInto?.lineAt(event.clientX, event.clientY);
        if (line) next = "code";
      }
      setZone(next);
      setCodeLine(line ? line.top - rect.top : null);
      event.dataTransfer.dropEffect = isPanel ? "move" : "link";
    }

    function onDragLeave(event) {
      if (!event.currentTarget.contains(event.relatedTarget)) setZone(null);
    }

    function onDrop(event) {
      const at = zone() ?? "center";
      setZone(null);
      drop(event, group.id, at, active());
    }

    return html`<section
      class="knitoutjs-group"
      onDragOver=${onDragOver}
      onDragLeave=${onDragLeave}
      onDrop=${onDrop}
    >
      <header class="knitoutjs-tabs" role="tablist" ref=${(el) => (tabs = el)}>
        <${For} each=${() => group.panels}>
          ${(panel) => html`<${Tab} panel=${panel} group=${group} active=${() => active() === panel} />`}
        <//>
        <button
          class="knitoutjs-add"
          title="open or make a file"
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
          ${(panel) => html`<div
            class="knitoutjs-panel"
            hidden=${() => active() !== panel}
            data-colour=${() => docColour(panel.url)}
            data-glow=${() => glow(panel.url)}
            ...${hoverProps(panel.url)}
          >
            <${Slot} panel=${panel} />
          </div>`}
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
      title=${() => `${info.name} · ${panel.url}`}
      onClick=${() => updateLayout((tree) => activate(tree, group.id, panel.id))}
      onDragStart=${(event) => {
        event.dataTransfer.setData(PANEL_TYPE, panel.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      ...${hoverProps(panel.url)}
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
      <span class="knitoutjs-tag">${() => TOOLS[panel.tool]?.name ?? panel.tool}</span>
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
  // which tools can show it
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
        ...${hoverProps(panel.url)}
      >
        ${() => (copied() ? "copied" : panel.url)}
      </button>
      ${() =>
        info.source &&
        html`<span
          class="knitoutjs-link"
          data-colour=${docColour(info.source)}
          ...${hoverProps(info.source)}
        >
          written by
          <span class="knitoutjs-swatch"></span>
          <span class="knitoutjs-link-name">${() => docInfo(info.source).name}</span>
        </span>`}
      <span class="knitoutjs-spacer"></span>
      <div class="knitoutjs-switch" role="group">
        <${For} each=${() => toolsFor(info.extension)}>
          ${(tool) => html`<button
            aria-pressed=${() => String(panel.tool === tool.id)}
            onClick=${() => updateLayout((tree) => setTool(tree, panel.id, tool.id))}
          >
            ${tool.name}
          </button>`}
        <//>
      </div>
    </div>`;
  }

  function Empty() {
    return html`<div
      class="knitoutjs-empty"
      onDragOver=${(event) => {
        if (!isOurDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "link";
      }}
      onDrop=${(event) => drop(event, null, "center")}
    >
      <div class="knitoutjs-empty-card">
        <h2 class="knitoutjs-rough">nothing's open</h2>
        <p>drag a .js or .k file in from the sidebar, or</p>
        <div class="knitoutjs-empty-actions">
          <button class="knitoutjs-button" onClick=${() => newPattern(null)}>
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
        each=${() => projectFiles().filter((file) => canOpen(file.extension))}
        fallback=${html`<div class="knitoutjs-menu-empty">nothing yet</div>`}
      >
        ${(file) => html`<button
          class="knitoutjs-menu-item knitoutjs-menu-file"
          data-colour=${docColour(file.url)}
          onClick=${fromMenu((groupId) => openDocs([file.url], groupId))}
          ...${hoverProps(file.url)}
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
      <p class="knitoutjs-menu-hint">or drag a .js or .k in from the sidebar</p>
    </div>`;
  }

  const dispose = render(
    () =>
      html`<link rel="stylesheet" href=${STYLESHEET} />
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
        <div
          class="knitoutjs-frame"
          ref=${(el) => (root = el)}
          data-resizing=${resizing}
          onDragEnter=${onRootDragEnter}
          onDragLeave=${onRootDragLeave}
        >
          ${() => (layout.root ? html`<${Node} node=${layout.root} />` : html`<${Empty} />`)}
          <${Menu} />
        </div>`,
    element,
  );

  return () => {
    handle.off("change", readDoc);
    document.removeEventListener("dragend", stopDragging);
    document.removeEventListener("drop", stopDragging);
    clearTimeout(noticeTimer);
    for (const [id, host] of hosts) destroyHost(id, host);
    for (const { off } of infos.values()) off?.();
    dispose();
  };
}
