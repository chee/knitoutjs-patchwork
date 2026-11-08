// nothing imported up here: patchwork may read this list in a worker, which
// has no import map, so a bare import anywhere below this file stops the
// whole package registering. what each plugin needs, its load() imports

// knitoutjs's projects from before. the tool shows only a button to update
// one to a knitoutjs-project
const OLD_TYPES = ["prototype-knitoutjs-panes", "knitoutjs-panes"];

export const plugins = [
  {
    type: "patchwork:datatype",
    id: "knitoutjs-project",
    name: "Knitout JS",
    icon: "Shirt",
    async load() {
      const { KnitoutJSDatatype } = await import("./datatype.js");
      return KnitoutJSDatatype;
    },
  },
  {
    type: "patchwork:datatype",
    id: "prototype-knitoutjs-panes",
    name: "Knitout JS (from before)",
    icon: "Shirt",
    unlisted: true,
    async load() {
      const { OldKnitoutJSDatatype } = await import("./datatype.js");
      return OldKnitoutJSDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "knitoutjs-project",
    name: "Knitout JS",
    icon: "Shirt",
    supportedDatatypes: ["knitoutjs-project", "lattice:project", ...OLD_TYPES],
    async load() {
      const { default: KnitoutProjectTool } = await import("./tool.js");
      return KnitoutProjectTool;
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
