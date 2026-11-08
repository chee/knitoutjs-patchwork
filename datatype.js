// a knitoutjs project: a pattern to start, its .js and the .k it writes, side
// by side. nothing here imports a package (see core/project.js)
import defaultJavaScriptContent from "./core/default-source.js";
import { newFileDoc } from "./files.js";
import { newPanel, newGroup, newSplit } from "./core/layout.js";
import { newProjectParts, projectTitle } from "./core/project.js";

export const KnitoutJSDatatype = {
  // patchwork calls this inside handle.change without waiting for it, so
  // everything written to `doc` has to happen before the first await
  init(doc, repo) {
    doc.title = "Knitout!";

    const kDoc = newFileDoc("pattern.k");
    const k = repo.create(kDoc);
    const jsDoc = { ...newFileDoc("pattern.knitout.js", defaultJavaScriptContent), knitoutTarget: k.url };
    const js = repo.create(jsDoc);

    Object.assign(
      doc,
      newProjectParts(repo, {
        title: doc.title,
        links: [
          { name: jsDoc.name, type: "file", url: js.url },
          { name: kDoc.name, type: "file", url: k.url },
        ],
        tree: newSplit("row", [
          newGroup([newPanel(js.url, "editor")]),
          newGroup([newPanel(k.url, "editor")]),
          newGroup([newPanel(k.url, "visualizer")]),
        ]),
      }),
    );

    // fill the .k, so the visualizer has stitches the first time you look
    import("./core/run.js").then(({ runInto }) => runInto(js, k, repo));
  },

  getTitle(doc) {
    return projectTitle(doc);
  },

  setTitle(doc, title) {
    doc.title = title;
  },
};

// a project from before (see core/migrate.js). its tool shows only a button
// to update it
export const OldKnitoutJSDatatype = {
  init() {},
  getTitle(doc) {
    return doc.title || "Knitout JS";
  },
  setTitle(doc, title) {
    doc.title = title;
  },
};
