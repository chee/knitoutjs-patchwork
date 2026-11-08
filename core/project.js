// a project: {title, layout, files}. `layout` links its layout doc (the flat
// nodes in layout.js), `files` a folder or a pushwork directory of its files.
// the project doc is the arrangement, and it's what drafts are of.
//
// nothing imported here imports a package, so a datatype can use it wherever
// patchwork loads one
import * as Layout from "./layout.js";

// knitoutjs's and lattice's: the same shape, with each app's own id
export const PROJECT_TYPES = ["knitoutjs-project", "lattice:project"];
export const LAYOUT_TYPE = "latticework:layout";

// knitoutjs's projects from before: {title, files: [urls], layout: tree}
export const OLD_KNITOUTJS_TYPES = ["prototype-knitoutjs-panes", "knitoutjs-panes"];

// the tools that show a whole project: never offered in a pane of one
export const PROJECT_TOOLS = ["knitoutjs-project", "lattice:project", "lattice", ...OLD_KNITOUTJS_TYPES];

const string = (value) => (value == null ? "" : String(value));

export const typeOf = (doc) => string(doc?.["@patchwork"]?.type);

export function projectTitle(doc) {
  return string(doc?.title) || "untitled";
}

// a layout doc: of a tree made with layout.js's newSplit, newGroup and
// newPanel (or an old one), or empty
export function newLayoutDoc(repo, tree = null) {
  return repo.create({
    "@patchwork": { type: LAYOUT_TYPE },
    nodes: tree ? Layout.fromTree(tree).nodes : {},
  });
}

// what a new project links to: a folder of some docs ([{name, type, url}],
// as a folder keeps them) and a layout. made in the same task, so a
// datatype's init can write their urls before it awaits anything
export function newProjectParts(repo, { title = "untitled", links = [], tree = null } = {}) {
  const folder = repo.create({ "@patchwork": { type: "folder" }, title, docs: links });
  const layout = newLayoutDoc(repo, tree);
  return { files: folder.url, layout: layout.url };
}

// a project datatype for patchwork: a new one has an empty folder and layout
export function projectDatatype({ title = "untitled" } = {}) {
  return {
    init(doc, repo) {
      doc.title = title;
      Object.assign(doc, newProjectParts(repo, { title }));
    },
    getTitle: projectTitle,
    setTitle(doc, title) {
      doc.title = title;
    },
  };
}

// a layout doc, on its own
export const layoutDatatype = {
  init(doc) {
    doc.nodes = {};
  },
  getTitle() {
    return "layout";
  },
  setTitle() {},
};
