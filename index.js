import defaultJavaScriptContent from "./default-source.js";
import { newFileDoc } from "./files.js";
import { newPanel, newGroup, newSplit } from "./layout.js";

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
    import("./run.js").then(({ runInto }) => runInto(js, k, repo));
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
    id: "knitoutjs-panes",
    name: "KnitoutJS Editor",
    icon: "Shirt",
    async load() {
      return KnitoutJSDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "knitoutjs-panes",
    name: "Knitout JS Editor",
    icon: "Shirt",
    supportedDatatypes: ["knitoutjs-panes"],
    async load() {
      const { default: KnitoutFrameTool } = await import("./frame.js");
      return KnitoutFrameTool;
    },
  },
  {
    type: "patchwork:tool",
    id: "knitoutjs-panes-visualizer",
    name: "Knitout Visualizer",
    icon: "Grid3x3",
    supportedDatatypes: ["file"],
    async load() {
      const { default: KnitoutVisualizerTool } = await import(
        "./visualizer.js"
      );
      return KnitoutVisualizerTool;
    },
  },
];
