// the files this frame shows, and which tools open them. what we know about
// the files themselves is in core (shared with lattice)
export * from "./core/files.js";

// the first tool that fits a file is the one it opens in. anything that
// isn't a .js or .k shows in a patchwork view
export const TOOLS = {
  visualizer: {
    id: "visualizer",
    name: "visualiser",
    title: "draw the stitches this .k makes",
    // where it sits in a tab's tool menu
    position: 2,
    extensions: ["k"],
    load: () => import("./core/visualizer.js"),
  },
  editor: {
    id: "editor",
    name: "text",
    title: "see the file's text (and change it, if it isn't generated)",
    position: 1,
    extensions: ["js", "k"],
    load: () => import("./core/editor.js"),
  },
  patchwork: {
    id: "patchwork",
    name: "patchwork",
    title: "show this doc with patchwork's own tool for it",
    extensions: ["*"],
    load: () => import("./core/patchwork-pane.js"),
  },
};

export function toolsFor(extension) {
  const tools = Object.values(TOOLS).filter((tool) =>
    tool.extensions.includes(extension),
  );
  return tools.length ? tools : [TOOLS.patchwork];
}
