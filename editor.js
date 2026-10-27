import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import html from "solid-js/html";
import { Prec } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { knitoutEditorIntegration, showError } from "./cm-knitout.js";
import { docColour, fileExtension } from "./files.js";
import { runInto } from "./run.js";

const AUTO_RUN_DELAY = 600;

// patchwork's file tool asks for extra CodeMirror extensions with this event,
// just before it makes its editor (see base/file's README)
const EXTENSIONS_EVENT = "file:codemirror-extensions";

// "2x2 rib.knitout.js" → _2x2Rib
function identifierFor(name) {
  const words = name
    .replace(/\..*$/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const id = words
    .map((word, index) =>
      index
        ? word[0].toUpperCase() + word.slice(1)
        : word[0].toLowerCase() + word.slice(1)
    )
    .join("") || "doc";
  return /^[0-9]/.test(id) ? "_" + id : id;
}

/**
 * the .js and .k files of a knitout project, in patchwork's own file editor
 * (a <patchwork-view tool-id="file">), with the knitout bits added to it.
 *
 * context:
 * - repo
 * - events: where visualizer events arrive and selection highlights go
 * - project: { files() → [{url, name, extension}], createFile(name) → url }
 * - hover(url | null): light up the panes showing a doc
 * - open(url, element, edge): show a doc beside this one (or bring it forward)
 * - editableCopy(url, element): copy a generated .k as text you can edit
 *
 * a .js file gets a run bar: it writes its knitout into a .k file. docs
 * dropped onto its code become imports (the frame asks `element.dropInto`)
 */
export default function KnitoutEditorTool(handle, element, context) {
  const { repo, events, project, hover, open, editableCopy } = context;
  const isJs = fileExtension(handle.doc()) === "js";

  let view = null;
  let run;

  // the file tool's editor, once it's made
  const holdView = ViewPlugin.define((made) => {
    view = made;
    return {
      destroy() {
        if (view === made) view = null;
      },
    };
  });

  function onExtensions(event) {
    const { handle: fileHandle, extensions } = event.detail;
    if (fileHandle?.url !== handle.url) return;
    extensions.push(
      holdView,
      knitoutEditorIntegration({
        events,
        url: handle.url,
        onSelectLines: (detail) =>
          events.dispatchEvent(
            new CustomEvent("knitout:highlight-lines", { detail }),
          ),
      }),
    );
    if (run) {
      extensions.push(
        Prec.high(
          keymap.of([{ key: "Mod-Enter", run: () => (run.now(), true) }]),
        ),
      );
    }
  }
  element.addEventListener(EXTENSIONS_EVENT, onExtensions);

  // run the pattern into its target .k: by hand, or after every pause in
  // typing when autorun is on. autorun is remembered in this browser, for each
  // .js (not in the doc, so two people don't both autorun into one .k)
  function createRunner() {
    const [target, setTarget] = createSignal(handle.doc()?.knitoutTarget);
    const autorunKey = `knitoutjs:autorun:${handle.url}`;
    const [auto, setAutoSignal] = createSignal(readAutorun());

    function readAutorun() {
      try {
        return localStorage.getItem(autorunKey) === "on";
      } catch {
        return false;
      }
    }

    function setAuto(on) {
      setAutoSignal(on);
      try {
        if (on) localStorage.setItem(autorunKey, "on");
        else localStorage.removeItem(autorunKey);
      } catch {}
    }
    const [status, setStatus] = createSignal({ state: "idle" });
    const running = () => status().state === "running";
    let timer;
    let current;

    const onChange = () => {
      setTarget(handle.doc()?.knitoutTarget);
      // an error is about the code as it was; once that changes, it's gone
      if (status().state === "error" && status().line != null) {
        setStatus({ state: "idle" });
      }
      if (auto()) {
        clearTimeout(timer);
        timer = setTimeout(now, AUTO_RUN_DELAY);
      }
    };
    handle.on("change", onChange);
    onCleanup(() => {
      clearTimeout(timer);
      current?.abort();
      handle.off("change", onChange);
    });

    // a new run takes over from one still going. a generated .k is read
    // only; a .k with editable text in it (someone's copy, or one typed by
    // hand) isn't written over without asking
    async function now({ overwrite = false } = {}) {
      const url = target();
      if (!url) {
        setStatus({ state: "error", message: "pick a .k file to write to" });
        return;
      }
      const kHandle = await repo.find(url);
      const content = kHandle.doc()?.content;
      if (typeof content === "string" && content.trim() && !overwrite) {
        setStatus({
          state: "ask",
          message: `${kHandle.doc()?.name ?? "the .k"} has editable text in it`,
        });
        return;
      }
      current?.abort();
      const run = (current = new AbortController());
      setStatus({ state: "running" });
      const result = await runInto(handle, kHandle, repo, {
        signal: run.signal,
      });
      if (current !== run) return;
      current = null;
      if (result.error?.stopped) {
        setStatus({ state: "idle", message: "stopped" });
      } else if (result.error) {
        const error = {
          line: result.error.line ?? null,
          message: String(result.error.message ?? result.error),
        };
        setStatus({ state: "error", ...error });
        if (view && error.line != null) showError(view, error);
      } else {
        if (view) showError(view, null);
        const lines = result.knitout.split("\n").length;
        setStatus({
          state: "ok",
          message: `ran in ${
            Math.round(result.ms)
          }ms · ${lines.toLocaleString()} lines`,
        });
      }
    }

    function pickTarget(url) {
      handle.change((doc) => {
        doc.knitoutTarget = url;
      });
    }

    async function newTarget() {
      const base = (handle.doc()?.name ?? "pattern").replace(
        /\.knitout\.js$|\.js$/,
        "",
      );
      pickTarget(await project.createFile(base + ".k"));
    }

    function stop() {
      current?.abort();
    }

    function goToLine(lineNumber) {
      if (!view) return;
      const line = view.state.doc.line(
        Math.max(1, Math.min(lineNumber, view.state.doc.lines)),
      );
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: "center" }),
      });
      view.focus();
    }

    function keep() {
      setStatus({ state: "idle", message: "kept it as it is" });
    }

    return {
      target,
      auto,
      setAuto,
      status,
      running,
      now,
      stop,
      keep,
      goToLine,
      pickTarget,
      newTarget,
    };
  }

  function RunBar() {
    const kFiles = createMemo(() =>
      project.files().filter((file) => file.extension === "k")
    );
    const targetColour = () => docColour(run.target());

    function onPick(event) {
      const value = event.currentTarget.value;
      if (value === "+new") {
        event.currentTarget.value = run.target() ?? "";
        run.newTarget();
      } else if (value) {
        run.pickTarget(value);
      }
    }

    return html`<div class="knitoutjs-runbar">
      <button
        class="knitoutjs-button knitoutjs-run"
        data-running=${() => (run.running() ? "" : undefined)}
        title=${() =>
      run.running()
        ? "stop this run"
        : "run the pattern: it writes its knitout into the .k file chosen on the right (⌘↵)"}
        onClick=${() => (run.running() ? run.stop() : run.now())}
      >
        ${() => (run.running() ? "stop" : "run")}
      </button>
      <label
        class="knitoutjs-auto"
        title="run again by itself whenever you stop typing for a moment. this browser remembers it for this file"
      >
        <input
          type="checkbox"
          checked=${run.auto}
          onChange=${(event) => run.setAuto(event.currentTarget.checked)}
        />
        autorun
      </label>
      <span class="knitoutjs-status" data-state=${() => run.status().state}>
        <${Show} when=${() => run.status().line != null}>
          <button
            class="knitoutjs-error-line"
            title="go to this line"
            onClick=${() => run.goToLine(run.status().line)}
          >
            line ${() => run.status().line}:
          </button>
        <//>
        ${() =>
      run.status().state === "running"
        ? "running…"
        : (run.status().message ?? "")}
      </span>
      <${Show} when=${() => run.status().state === "ask"}>
        <span class="knitoutjs-ask">
          <button
            class="knitoutjs-button"
            onClick=${() => run.now({ overwrite: true })}
          >
            overwrite it
          </button>
          <button class="knitoutjs-button" onClick=${() => run.keep()}>
            keep it
          </button>
        </span>
      <//>
      <label
        class="knitoutjs-target"
        title="the .k file this pattern writes its knitout (the machine's instructions) into"
        data-colour=${targetColour}
        onPointerEnter=${() => hover(run.target())}
        onPointerLeave=${() => hover(null)}
      >
        <span class="knitoutjs-target-label">into</span>
        <span class="knitoutjs-swatch"></span>
        <select onChange=${onPick}>
          <option value="" disabled selected=${() => !run.target()}>
            choose a .k file
          </option>
          <${For} each=${kFiles}>
            ${(file) =>
      html`
        <option
          value=${file.url}
          selected=${() => file.url === run.target()}
        >
                        ${file.name}
                      </option>
      `}
          <//>
          <option value="+new">new .k file…</option>
        </select>
      </label>
      <button
        class="knitoutjs-open"
        title="show that .k file beside this one"
        disabled=${() => !run.target()}
        onClick=${() => open(run.target(), element, "right")}
      >
        open
      </button>
    </div>`;
  }

  // a .k that a .js wrote is stored whole, so it's read only here
  function ReadOnlyNote() {
    const [doc, setDoc] = createSignal(handle.doc());
    const onChange = () => setDoc(handle.doc());
    handle.on("change", onChange);
    onCleanup(() => handle.off("change", onChange));
    const writer = () =>
      project.files().find((file) => file.url === doc()?.knitoutSource)?.name;
    return html`
      <${Show}
        when=${() => !isJs && doc() && typeof doc().content !== "string"}
      >
        <div class="knitoutjs-readonly">
          <span>
                read only: ${() =>
                  writer() ?? "a pattern"} writes this file each
                time it runs
              </span>
          <button
            class="knitoutjs-button"
            title="make a copy of this .k as text you can change by hand"
            onClick=${() => editableCopy(handle.url, element)}
          >
                make an editable copy
              </button>
        </div>
        <//>
    `;
  }

  const dispose = render(() => {
    run = isJs ? createRunner() : null;
    return html`
      <div class="knitoutjs-editor">
        <${Show} when=${isJs}>
          <${RunBar} />
          <//>
          <${ReadOnlyNote} />
          <patchwork-view attr:doc-url=${handle
            .url} tool-id="file"></patchwork-view>
          </div>
    `;
  }, element);

  // dropping docs onto the code writes a line above the one under the pointer:
  // a .js comes in with `await import`, anything else with `await repo.find`
  function lineAt(x, y) {
    if (!view) return null;
    const line = view.state.doc.lineAt(view.posAtCoords({ x, y }, false));
    return {
      line: line.number,
      top: view.documentTop + view.lineBlockAt(line.from).top,
    };
  }

  async function drop(docs, x, y) {
    const under = lineAt(x, y);
    if (!under) return;
    const at = view.state.doc.line(under.line).from;
    const lines = await Promise.all(
      docs.map(async ({ url, name }) => {
        const doc = (await repo.find(url)).doc();
        const id = identifierFor(name ?? doc?.name ?? doc?.title ?? "doc");
        return fileExtension(doc) === "js"
          ? `const ${id} = await import("/${url}")\n`
          : `const ${id} = await repo.find("${url}")\n`;
      }),
    );
    view.dispatch({ changes: { from: at, insert: lines.join("") } });
    view.focus();
  }

  if (isJs) element.dropInto = { lineAt, drop };

  return () => {
    delete element.dropInto;
    element.removeEventListener(EXTENSIONS_EVENT, onExtensions);
    dispose();
  };
}
