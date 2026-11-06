import defaultJavaScriptContent from "./core/default-source.js";
import { newFileDoc } from "./files.js";
import { newPanel, newGroup, newSplit } from "./core/layout.js";

export const KnitoutJSDatatype = {
  // patchwork calls this inside handle.change without waiting for it, so
  // everything written to `doc` has to happen before the first await
  init(doc, repo) {
    doc.title = "Knitout!";

    const k = repo.create(newFileDoc("pattern.k"));
    const js = repo.create({
      ...newFileDoc("pattern.knitout.js", defaultJavaScriptContent),
      knitoutTarget: k.url,
    });

    doc.files = [js.url, k.url];
    doc.layout = newSplit("row", [
      newGroup([newPanel(js.url, "editor")]),
      newGroup([newPanel(k.url, "editor")]),
      newGroup([newPanel(k.url, "visualizer")]),
    ]);

    // fill the .k, so the visualizer has stitches the first time you look
    import("./core/run.js").then(({ runInto }) => runInto(js, k, repo));
  },

  getTitle(doc) {
    return doc.title || "Knitout JS";
  },

  setTitle(doc, title) {
    doc.title = title;
  },
};

export const plugins = [
  {
    type: "patchwork:datatype",
    id: "prototype-knitoutjs-panes",
    name: "Prototype KnitoutJS Editor",
    icon: "Shirt",
    async load() {
      return KnitoutJSDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "prototype-knitoutjs-panes",
    name: "Prototype Knitout JS Editor",
    icon: "Shirt",
    supportedDatatypes: ["prototype-knitoutjs-panes"],
    async load() {
      const { default: KnitoutFrameTool } = await import("./frame.js");
      return KnitoutFrameTool;
    },
  },
  {
    type: "patchwork:tool",
    id: "prototype-knitoutjs-panes-visualizer",
    name: "Prototype Knitout Visualizer",
    icon: "Grid3x3",
    supportedDatatypes: ["file"],
    async load() {
      const { default: KnitoutVisualizerTool } = await import(
        "./core/visualizer.js"
      );
      return KnitoutVisualizerTool;
    },
  },
];
