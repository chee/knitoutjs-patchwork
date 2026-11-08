// a patchwork folder: {title, docs: [{name, type, url}]}, links to other
// docs, as patchwork's folder tool makes them. and a project's files, kept
// in one
import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import { shortUrl } from "./files.js";
import { describeDoc } from "./patchwork-docs.js";

// a string in a doc can be a plain string or an ImmutableString (pushwork
// writes links that way); read them the same
function asString(value) {
  return value == null ? undefined : String(value);
}

// the urls a folder doc links to, in order
export function folderUrls(doc) {
  return (Array.isArray(doc?.docs) ? doc.docs : [])
    .map((link) => asString(link?.url))
    .filter((url) => url && isValidAutomergeUrl(url));
}

export function folderTitle(doc) {
  return asString(doc?.title) || "untitled";
}

// the entry a folder keeps for a doc: what patchwork's folder tool writes
export function folderLink(url, doc, title) {
  return {
    name: asString(doc?.name ?? doc?.title ?? title) || shortUrl(url),
    type: asString(doc?.["@patchwork"]?.type) || "file",
    url,
  };
}

/**
 * a project's files, kept in a folder: what latticework reads and changes
 * them through.
 *
 *   urls()           the files' urls, in order
 *   title()          what the folder's called
 *   add(urls)        link docs from the folder (ones it has are left)
 *   remove(url)      unlink a doc. the doc itself stays
 *   subscribe(fn)    hear about changes. returns a way to stop
 */
export function folderFiles(handle, repo) {
  return {
    urls: () => folderUrls(handle.doc()),
    title: () => folderTitle(handle.doc()),
    async add(urls) {
      const have = folderUrls(handle.doc());
      const links = await Promise.all(
        urls
          .filter((url) => !have.includes(url))
          .map(async (url) => {
            const { name, type } = await describeDoc(url, repo);
            return { name: name || shortUrl(url), type, url };
          }),
      );
      if (!links.length) return;
      handle.change((doc) => {
        doc.docs ??= [];
        const now = folderUrls(doc);
        for (const link of links) if (!now.includes(link.url)) doc.docs.push(link);
      });
    },
    remove(url) {
      handle.change((doc) => {
        const docs = doc.docs ?? [];
        for (let i = docs.length - 1; i >= 0; i--) {
          if (String(docs[i]?.url) === url) docs.splice(i, 1);
        }
      });
    },
    subscribe(fn) {
      handle.on("change", fn);
      return () => handle.off("change", fn);
    },
  };
}
