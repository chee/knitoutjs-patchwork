// updating projects from before: one way, and the type changes, so the old
// tools (which only open the old types) won't open them after. each is done
// on the doc itself, through the repo under any draft overlay, never on a
// draft's copy of it. and the drafts go: they're forks of the old shape, and
// merging one back would bring the old shape back with it
import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import { OLD_KNITOUTJS_TYPES, projectTitle, typeOf } from "./project.js";
import * as Layout from "./layout.js";
import { folderFiles, folderTitle } from "./folder.js";
import { createDoc, findSoon } from "./patchwork-docs.js";
import { seedActive } from "./active.js";

const string = (value) => (value == null ? "" : String(value));
const isUrl = (value) => isValidAutomergeUrl(string(value));
const copy = (value) => (value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : null);

export const isOldKnitoutjs = (doc) => OLD_KNITOUTJS_TYPES.includes(typeOf(doc));

/**
 * what a project has, made from the shape before projects: a folder of
 * `urls`, and the nodes of `tree`. returns {files: the folder's url, nodes,
 * active}. `active` is which tab each group of the tree showed: hand it to
 * seedActive with the project's url, so whoever updated it keeps theirs
 */
export async function partsFrom({ title, urls = [], tree = null }, repo, hive) {
  const folder = await createDoc(repo, { "@patchwork": { type: "folder" }, title, docs: [] }, hive);
  await folderFiles(folder, repo).add(urls.map(string).filter(isUrl));
  return { files: folder.url, ...Layout.fromTree(copy(tree)) };
}

/**
 * a knitoutjs project from before becomes a knitoutjs-project, in place: its
 * files go in a new folder, its tree becomes its nodes. `handle` is the doc's
 * own, from `repo`. says whether it was this that did it (someone else may
 * have, meanwhile)
 */
export async function updateKnitoutjs(handle, repo, hive) {
  const doc = handle.doc();
  const from = typeOf(doc);
  if (!OLD_KNITOUTJS_TYPES.includes(from)) return false;
  const title = projectTitle(doc);
  const { files, nodes, active } = await partsFrom(
    { title, urls: Array.isArray(doc.files) ? doc.files : [], tree: doc.layout },
    repo,
    hive,
  );
  let done = false;
  handle.change((doc) => {
    if (typeOf(doc) !== from) return;
    doc["@patchwork"].type = "knitoutjs-project";
    delete doc["@patchwork"].mainDraftUrl;
    doc.title = title;
    doc.files = files;
    delete doc.layout;
    doc.nodes = nodes;
    done = true;
  });
  if (done) seedActive(handle.url, active);
  return done;
}

// a lattice project from before is a folder of its files, with its layout on
// a lattice:workspace doc it links as `workspace` (or, before workspaces, on
// the folder itself as `layout`)
export function isOldLatticeFolder(doc) {
  return (
    typeOf(doc) === "folder" &&
    (isUrl(doc.project) || isUrl(doc.workspace) || !!copy(doc.layout))
  );
}

// the project an old lattice folder became, if it's been updated: the folder
// links to it as `project` (or still as `workspace`, if the update was cut
// short before the folder changed)
export async function updatedTo(folder, repo) {
  if (isUrl(folder?.project)) return string(folder.project);
  if (!isUrl(folder?.workspace)) return null;
  const workspace = await findSoon(repo, string(folder.workspace));
  return typeOf(workspace) === "lattice:project" ? string(folder.workspace) : null;
}

// the folder's done being a project: it's the project's files now, and links
// back to it
function finish(folder, projectUrl) {
  folder.change((doc) => {
    if (string(doc.project) !== projectUrl) doc.project = projectUrl;
    if ("workspace" in doc) delete doc.workspace;
    if ("layout" in doc) delete doc.layout;
  });
}

/**
 * an old lattice project becomes a lattice:project. its workspace doc becomes
 * the project, in place, so its url and history stay with it (one from before
 * workspaces gets a new doc). the folder stays as its files. `folder` is the
 * folder's own handle, from `repo`. returns the project's url
 */
export async function updateLatticeFolder(folder, repo, { title, hive } = {}) {
  const already = await updatedTo(folder.doc(), repo);
  if (already) {
    finish(folder, already);
    return already;
  }
  const doc = folder.doc();
  title ??= folderTitle(doc);
  if (!isUrl(doc.workspace)) {
    const { nodes, active } = Layout.fromTree(copy(doc.layout));
    const project = await createDoc(
      repo,
      { "@patchwork": { type: "lattice:project" }, title, files: folder.url, nodes },
      hive,
    );
    seedActive(project.url, active);
    finish(folder, project.url);
    return project.url;
  }
  const project = await repo.find(string(doc.workspace));
  const { nodes, active } = Layout.fromTree(copy(project.doc()?.layout));
  let done = false;
  project.change((doc) => {
    if (typeOf(doc) !== "lattice:workspace") return;
    doc["@patchwork"].type = "lattice:project";
    delete doc["@patchwork"].mainDraftUrl;
    doc.title = title;
    doc.files = folder.url;
    delete doc.layout;
    doc.nodes = nodes;
    done = true;
  });
  if (typeOf(project.doc()) !== "lattice:project") {
    throw new Error(`its workspace is a ${typeOf(project.doc()) || "doc with no type"}`);
  }
  if (done) seedActive(project.url, active);
  finish(folder, project.url);
  return project.url;
}
