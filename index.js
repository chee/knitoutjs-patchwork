import defaultJavaScriptContent from "./default-source.js";
import { newFileDoc } from "./files.js";
import { newPanel, newGroup, newSplit } from "./layout.js";

export const KnitoutJSDatatype = {
  async init(doc, repo) {
    doc.title = "Knitout!";

    const k = await repo.create2(newFileDoc("pattern.k"));
    const js = await repo.create2({
      ...newFileDoc("pattern.knitout.js", defaultJavaScriptContent),
      knitoutTarget: k.url,
    });

    // fill the .k now, so the visualizer has stitches the first time you look
    const { runInto } = await import("./run.js");
    await runInto(js, k, repo);

    doc.files = [js.url, k.url];
    doc.layout = newSplit("row", [
      newGroup([newPanel(js.url, "editor")]),
      newGroup([newPanel(k.url, "editor")]),
      newGroup([newPanel(k.url, "visualizer")]),
    ]);
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
    id: "knitout-visualizer",
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
