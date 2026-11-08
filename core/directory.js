// a pushwork directory: {"@patchwork": {type: "directory", title}, [path]: url},
// its files kept by path. and a project's files, kept in one
import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import { shortUrl } from "./files.js";
import { describeDoc } from "./patchwork-docs.js";

// keys that aren't files (pushwork no longer writes lastSyncAt, but old
// directories have it)
const RESERVED = new Set(["@patchwork", "lastSyncAt"]);

// [path, url], by path
export function directoryEntries(doc) {
  return Object.entries(doc ?? {})
    .filter(([path, url]) => !RESERVED.has(path) && isValidAutomergeUrl(String(url)))
    .map(([path, url]) => [path, String(url)])
    .sort(([a], [b]) => a.localeCompare(b));
}

// the urls a directory links to, by path, each once
export function directoryUrls(doc) {
  return [...new Set(directoryEntries(doc).map(([, url]) => url))];
}

export function directoryTitle(doc) {
  const title = doc?.["@patchwork"]?.title;
  return (title == null ? "" : String(title)) || "untitled";
}

// a path for a doc that nothing else has: its name, or its name numbered
function freePath(doc, name) {
  name = name.replace(/\//g, "-") || "untitled";
  const taken = (path) => path in doc || RESERVED.has(path);
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const path = `${stem} ${n}${extension}`;
    if (!taken(path)) return path;
  }
}

/**
 * a project's files, kept in a directory: the same as folder.js's
 * folderFiles. a doc added goes in at its name
 */
export function directoryFiles(handle, repo) {
  return {
    urls: () => directoryUrls(handle.doc()),
    title: () => directoryTitle(handle.doc()),
    async add(urls) {
      const have = directoryUrls(handle.doc());
      const named = await Promise.all(
        urls
          .filter((url) => !have.includes(url))
          .map(async (url) => ({ url, name: (await describeDoc(url, repo)).name || shortUrl(url) })),
      );
      if (!named.length) return;
      handle.change((doc) => {
        const now = directoryUrls(doc);
        for (const { url, name } of named) if (!now.includes(url)) doc[freePath(doc, name)] = url;
      });
    },
    remove(url) {
      handle.change((doc) => {
        for (const [path, value] of Object.entries(doc)) {
          if (!RESERVED.has(path) && String(value) === url) delete doc[path];
        }
      });
    },
    subscribe(fn) {
      handle.on("change", fn);
      return () => handle.off("change", fn);
    },
  };
}
