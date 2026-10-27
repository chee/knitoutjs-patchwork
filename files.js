// what we know about the files a knitout project shows

export function docText(doc) {
  const content = doc?.content;
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (content instanceof Uint8Array) return new TextDecoder().decode(content);
  if (typeof content.val === "string") return content.val;
  return String(content);
}

// "js", "k", or whatever else the file says it is
export function fileExtension(doc) {
  if (doc?.extension) return doc.extension.replace(/^\./, "").toLowerCase();
  const match = doc?.name?.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

// the first tool that fits a file is the one it opens in. anything that
// isn't a .js or .k shows in a patchwork view
export const TOOLS = {
  visualizer: {
    id: "visualizer",
    name: "view",
    title: "draw the stitches this .k makes",
    // where it sits in a pane's edit | view switch
    position: 2,
    extensions: ["k"],
    load: () => import("./visualizer.js"),
  },
  editor: {
    id: "editor",
    name: "edit",
    title: "see the file's text (and change it, if it isn't generated)",
    position: 1,
    extensions: ["js", "k"],
    load: () => import("./editor.js"),
  },
  patchwork: {
    id: "patchwork",
    name: "patchwork",
    title: "show this doc with patchwork's own tool for it",
    extensions: ["*"],
    load: () => import("./patchwork-pane.js"),
  },
};

export function toolsFor(extension) {
  const tools = Object.values(TOOLS).filter((tool) =>
    tool.extensions.includes(extension),
  );
  return tools.length ? tools : [TOOLS.patchwork];
}

// each doc gets a colour of its own, so every pane showing it wears the same
// one. the colours are tokens in frame.css
export const DOC_COLOURS = [
  "cherry",
  "blue",
  "stem",
  "lilac",
  "peach",
  "butter",
];

export function docColour(url) {
  let hash = 0;
  for (const char of url ?? "") hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return DOC_COLOURS[Math.abs(hash) % DOC_COLOURS.length];
}

// automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu → 4NMNnk…
export function shortUrl(url) {
  return url ? url.replace(/^automerge:/, "").slice(0, 6) + "…" : "";
}

export function newFileDoc(name, content = "") {
  const extension = fileExtension({ name });
  return {
    "@patchwork": { type: "file" },
    name,
    extension,
    mimeType: extension === "js" ? "text/javascript" : "text/plain",
    content,
  };
}
