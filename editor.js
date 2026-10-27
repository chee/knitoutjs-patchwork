import { createSignal, createMemo, For, Show, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import html from "solid-js/html";
import {
  EditorState,
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  HighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  searchKeymap,
  highlightSelectionMatches,
  closeBrackets,
  closeBracketsKeymap,
  javascript,
  tags,
  automergeSyncPlugin,
} from "./vendor/codemirror.js";
import { knitoutEditorIntegration } from "./cm-knitout.js";
import { docText, fileExtension, docColour } from "./files.js";
import { runInto } from "./run.js";

const AUTO_RUN_DELAY = 600;

// the colours are frame.css tokens, so the editor follows the theme
const theme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--knitoutjs-sheet)",
    color: "var(--knitoutjs-ink)",
  },
  ".cm-scroller": {
    fontFamily: "var(--knitoutjs-mono)",
    lineHeight: "1.55",
  },
  ".cm-gutters": {
    backgroundColor: "var(--knitoutjs-sheet)",
    borderRight: "1px solid var(--knitoutjs-line-soft)",
    color: "var(--knitoutjs-muted)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "var(--knitoutjs-highlighter)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "var(--knitoutjs-selection)" },
  ".cm-cursor": {
    borderLeft: "2px solid var(--knitoutjs-cherry)",
  },
  "&.cm-focused": { outline: "none" },
});

const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword],
    color: "var(--knitoutjs-cherry-ink)",
  },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "var(--knitoutjs-stem-ink)",
  },
  {
    tag: [tags.number, tags.bool, tags.null],
    color: "var(--knitoutjs-blue-ink)",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--knitoutjs-lilac-ink)",
  },
  { tag: tags.definition(tags.variableName), fontWeight: "600" },
  {
    tag: tags.comment,
    color: "var(--knitoutjs-muted)",
    fontFamily: "var(--knitoutjs-serif)",
    fontStyle: "italic",
  },
]);

// "2x2 rib.knitout.js" → _2x2Rib
function identifierFor(name) {
  const words = name
    .replace(/\..*$/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const id =
    words
      .map((word, index) =>
        index
          ? word[0].toUpperCase() + word.slice(1)
          : word[0].toLowerCase() + word.slice(1),
      )
      .join("") || "doc";
  return /^[0-9]/.test(id) ? "_" + id : id;
}

/**
 * a text editor for the .js and .k files in a knitout project.
 *
 * context:
 * - repo
 * - events: where visualizer events arrive and selection highlights go
 * - project: { files() → [{url, name, extension}], createFile(name) → url }
 * - hover(url | null): light up the panes showing a doc
 *
 * a .js file gets a run bar: it writes its knitout into a .k file. docs
 * dropped onto its code become imports (the frame asks `element.dropInto`)
 */
export default function KnitoutEditorTool(handle, element, context) {
  const { repo, events, project, hover } = context;
  const isJs = fileExtension(handle.doc()) === "js";
  const editable = typeof handle.doc()?.content === "string";

  let view;
  let run;

  function mount(parent) {
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: docText(handle.doc()),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          syntaxHighlighting(highlight),
          bracketMatching(),
          closeBrackets(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([
            ...(run
              ? [{ key: "Mod-Enter", run: () => (run.now(), true) }]
              : []),
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          theme,
          isJs ? javascript() : [],
          editable
            ? automergeSyncPlugin({ handle, path: ["content"] })
            : EditorState.readOnly.of(true),
          knitoutEditorIntegration({
            events,
            url: handle.url,
            onSelectLines: (detail) =>
              events.dispatchEvent(
                new CustomEvent("knitout:highlight-lines", { detail }),
              ),
          }),
        ],
      }),
    });
  }

  // run the pattern into its target .k: by hand, or after every pause in
  // typing when auto is on. auto always starts off
  function createRunner() {
    const [target, setTarget] = createSignal(handle.doc()?.knitoutTarget);
    const [auto, setAuto] = createSignal(false);
    const [status, setStatus] = createSignal({ state: "idle" });
    let timer;

    const onChange = () => {
      setTarget(handle.doc()?.knitoutTarget);
      if (auto()) {
        clearTimeout(timer);
        timer = setTimeout(now, AUTO_RUN_DELAY);
      }
    };
    handle.on("change", onChange);
    onCleanup(() => {
      clearTimeout(timer);
      handle.off("change", onChange);
    });

    async function now() {
      const url = target();
      if (!url) {
        setStatus({ state: "error", message: "pick a .k file to write to" });
        return;
      }
      setStatus({ state: "running" });
      const result = await runInto(handle, await repo.find(url), repo);
      if (result.error) {
        setStatus({
          state: "error",
          message: String(result.error.message ?? result.error),
        });
      } else {
        const lines = result.knitout.split("\n").length;
        setStatus({
          state: "ok",
          message: `ran in ${Math.round(result.ms)}ms · ${lines.toLocaleString()} lines`,
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

    return { target, auto, setAuto, status, now, pickTarget, newTarget };
  }

  function RunBar() {
    const kFiles = createMemo(() =>
      project.files().filter((file) => file.extension === "k"),
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
        title="run (⌘↵)"
        onClick=${() => run.now()}
      >
        run
      </button>
      <label class="knitoutjs-auto">
        <input
          type="checkbox"
          checked=${run.auto}
          onChange=${(event) => run.setAuto(event.currentTarget.checked)}
        />
        auto
      </label>
      <span class="knitoutjs-status" data-state=${() => run.status().state}>
        ${() =>
          run.status().state === "running"
            ? "running…"
            : (run.status().message ?? "")}
      </span>
      <label
        class="knitoutjs-target"
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
              html`<option
                value=${file.url}
                selected=${() => file.url === run.target()}
              >
                ${file.name}
              </option>`}
          <//>
          <option value="+new">new .k file…</option>
        </select>
      </label>
    </div>`;
  }

  const dispose = render(() => {
    run = isJs ? createRunner() : null;
    return html`<div class="knitoutjs-editor">
      <${Show} when=${isJs}><${RunBar} /><//>
      <${Show} when=${!editable}>
        <div class="knitoutjs-note">
          read only: this file's text is saved as a fixed snapshot
        </div>
      <//>
      <div class="knitoutjs-codemirror" ref=${mount}></div>
    </div>`;
  }, element);

  // dropping docs onto the code writes a line above the one under the pointer:
  // a .js comes in with `await import`, anything else with `await repo.find`
  function lineAt(x, y) {
    const line = view.state.doc.lineAt(view.posAtCoords({ x, y }, false));
    return {
      line: line.number,
      top: view.documentTop + view.lineBlockAt(line.from).top,
    };
  }

  async function drop(docs, x, y) {
    const at = view.state.doc.line(lineAt(x, y).line).from;
    const lines = await Promise.all(
      docs.map(async ({ url, name }) => {
        const doc = (await repo.find(url)).doc();
        const id = identifierFor(name ?? doc?.name ?? "doc");
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
    view?.destroy();
    dispose();
  };
}
