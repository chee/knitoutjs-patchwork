// a project, shown: latticework on its nodes and files. one from before
// shows only a button to update it
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import html from "solid-js/html";
import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import { mountLatticework } from "./latticework.js";
import { PROJECT_TYPES, projectTitle, typeOf } from "./project.js";
import { isOldKnitoutjs, updateKnitoutjs } from "./migrate.js";
import { folderFiles } from "./folder.js";
import { directoryFiles } from "./directory.js";
import { createDoc } from "./patchwork-docs.js";

const STYLESHEET = new URL("./latticework.css", import.meta.url).href;

const string = (value) => (value == null ? "" : String(value));
const isUrl = (value) => isValidAutomergeUrl(string(value));

export function isProject(doc) {
  return PROJECT_TYPES.includes(typeOf(doc)) && isUrl(doc.files);
}

/**
 * a new project of `type`, with an empty layout. its files are the folder or
 * directory at `files`, or a new folder
 */
export async function createProject(repo, { type, title = "untitled", files, hive }) {
  files ??= (await createDoc(repo, { "@patchwork": { type: "folder" }, title, docs: [] }, hive)).url;
  return createDoc(repo, { "@patchwork": { type }, title, files, nodes: {} }, hive);
}

// a project's files, read and changed through the folder or directory
// they're kept in
export function filesOf(handle, repo) {
  return typeOf(handle.doc()) === "directory"
    ? directoryFiles(handle, repo)
    : folderFiles(handle, repo);
}

// the files, under the project's own title
function titledFiles(files, project) {
  return {
    ...files,
    title: () => projectTitle(project.doc()),
    subscribe(fn) {
      const off = files.subscribe(fn);
      project.on("change", fn);
      return () => {
        off();
        project.off("change", fn);
      };
    },
  };
}

/**
 * a card with a button to update something from before, and nothing else.
 * `update` does it, and throws to say what went wrong
 */
export function mountUpdate(element, update) {
  const [styled, setStyled] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal(null);
  async function onClick() {
    setBusy(true);
    setProblem(null);
    try {
      await update();
    } catch (error) {
      console.error("[latticework] couldn't update", error);
      setProblem(string(error?.message ?? error) || "couldn't update it");
    }
    setBusy(false);
  }
  return render(
    () => html`<link
        rel="stylesheet"
        href=${STYLESHEET}
        onLoad=${() => setStyled(true)}
        onError=${() => setStyled(true)}
      />
      <div
        class="knitoutjs-editor-tool latticework-update"
        style=${() => (styled() ? {} : { visibility: "hidden" })}
      >
        <div class="knitoutjs-empty">
          <div class="knitoutjs-empty-card">
            <h2 class="latticework-update-heading">made with an older version</h2>
            <p>older versions can't open it after · its drafts go</p>
            <div class="knitoutjs-empty-actions">
              <button class="knitoutjs-button" disabled=${busy} onClick=${onClick}>
                ${() => (busy() ? "updating…" : "update")}
              </button>
            </div>
            <${Show} when=${problem}>
              <p class="knitoutjs-empty-notice">${problem}</p>
            <//>
          </div>
        </div>
      </div>`,
    element,
  );
}

// something that isn't a project, or whose parts can't be found
function mountProblem(element, text) {
  return render(
    () => html`<link rel="stylesheet" href=${STYLESHEET} />
      <div class="knitoutjs-editor-tool latticework-update">
        <div class="knitoutjs-empty">
          <div class="knitoutjs-empty-card"><p>${text}</p></div>
        </div>
      </div>`,
    element,
  );
}

/**
 * a project in `element`: latticework on its nodes and files, or, for one
 * from before, a button to update it. it follows the project doc, so when
 * the update's done (here or anywhere) the panes show. returns a way to
 * unmount.
 *
 *   project   the project doc's handle, from `repo`
 *   baseRepo  the repo under any draft overlay: what updating is done
 *             through, so it's the doc itself that changes
 *
 * and the rest of latticework's options (see latticework.js): repo, hive,
 * tools, self, sidebar, menu, onShowing, onOpen
 */
export function mountProject(element, { project, repo, baseRepo = repo, hive, ...options }) {
  let shown = null;
  let dead = false;

  // what's showing depends on the doc's type and its files
  const keyOf = (doc) => (isOldKnitoutjs(doc) ? "old" : isProject(doc) ? string(doc.files) : "none");

  function show() {
    const doc = project.doc();
    const key = keyOf(doc);
    if (shown?.key === key) return;
    shown?.unmount();
    shown?.box.remove();
    // its own box in the element, which may be patchwork's, with more in it
    const box = document.createElement("div");
    box.style.display = "contents";
    element.append(box);
    const now = { key, box, unmount: () => {}, dead: false };
    shown = now;

    if (key === "old") {
      now.unmount = mountUpdate(box, async () => {
        const handle = await baseRepo.find(project.url);
        await updateKnitoutjs(handle, baseRepo, hive);
      });
      return;
    }
    if (key === "none") {
      now.unmount = mountProblem(box, `this is ${typeOf(doc) ? `a ${typeOf(doc)}` : "a doc with no type"}, not a project`);
      return;
    }

    let off = null;
    now.unmount = () => {
      now.dead = true;
      off?.();
    };
    // the files, and the same doc under any draft: who's in the project is
    // heard over that, so everyone's in one room, on whichever draft
    Promise.all([repo.find(string(doc.files)), baseRepo.find(string(doc.files))]).then(
      ([files, room]) => {
        if (now.dead || dead) return;
        off = mountLatticework(box, {
          layout: project,
          files: titledFiles(filesOf(files, repo), project),
          room,
          repo,
          baseRepo,
          hive,
          ...options,
        });
      },
      (error) => {
        if (now.dead || dead) return;
        console.error("[latticework] couldn't find the project's files", error);
        off = mountProblem(box, "couldn't find its files");
      },
    );
  }

  project.on("change", show);
  show();

  return () => {
    dead = true;
    project.off("change", show);
    shown?.unmount();
    shown?.box.remove();
  };
}
