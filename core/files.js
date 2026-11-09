// what we know about the files a knitout project shows. which tools open
// them is up to the frame showing them (its own files.js)

export function docText(doc) {
  const content = doc?.content;
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (content instanceof Uint8Array) return new TextDecoder().decode(content);
  if (typeof content.val === "string") return content.val;
  return String(content);
}

// a short fingerprint of some text (fnv-1a): a .k keeps one of the code it
// was built from, so anyone can see when that code has changed since
export function textHash(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// download some text as a file
export function saveFile(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// a module worker, from a script that may be on another origin (the site
// loading these panes from where they're hosted). a worker can't be started
// from another origin's script, but a blob of this origin's can import it
// (with cors)
export function moduleWorker(url) {
  if (new URL(url).origin === location.origin) return new Worker(url, { type: "module" });
  const source = `import ${JSON.stringify(String(url))};`;
  const blob = new Blob([source], { type: "text/javascript" });
  return new Worker(URL.createObjectURL(blob), { type: "module" });
}

// "js", "k", or whatever else the file says it is
export function fileExtension(doc) {
  if (doc?.extension) return doc.extension.replace(/^\./, "").toLowerCase();
  const match = doc?.name?.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

// a doc's name, with its extension (a UnixFileEntry's `extension`, or what
// the app says it is) after it, if the name hasn't one of its own. so
// everything shows as a file: pattern.k, kniterate.machine
export function withExtension(name, extension) {
  name = String(name ?? "");
  extension = String(extension ?? "").replace(/^\./, "");
  if (!name || !extension || /\.[^.\s/]+$/.test(name)) return name;
  return `${name}.${extension}`;
}

// each doc gets a colour of its own, so every pane showing it wears the same
// one. the colours are tokens in latticework.css
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
