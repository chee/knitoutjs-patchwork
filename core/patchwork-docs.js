// patchwork's docs: finding a url in some text, and making docs of its
// datatypes. not in files.js: these import packages, and files.js is read
// where there's no import map
import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import { getRegistry, isKeyhiveDoc } from "@inkandswitch/patchwork-plugins";

// an automerge url in some text: the url itself, or a patchwork link's
// #doc=automerge:<id> (or the older #doc=<id>)
export function urlFromText(text) {
  const trimmed = text.trim();
  if (isValidAutomergeUrl(trimmed)) return trimmed;
  const doc = trimmed.match(/#(?:.*&)?doc=([^&\s]+)/)?.[1];
  if (!doc) return null;
  const url = doc.startsWith("automerge:") ? doc : `automerge:${doc}`;
  return isValidAutomergeUrl(url) ? url : null;
}

// a datatype from patchwork's registry, or undefined if there isn't one
export async function loadDatatype(type) {
  if (!type || type === "file") return undefined;
  try {
    return await getRegistry("patchwork:datatype").load(type);
  } catch {
    return undefined;
  }
}

// a new doc of one of patchwork's datatypes, like patchwork-plugins'
// createDocOfDatatype2 but recording only its type: no suggestedImportUrl
// (or frozenImportUrl) saying where the datatype was loaded from
export async function createDocOfDatatype(datatype, repo, change, hive) {
  const handle = await repo.create2();
  // a keyhive doc gets the sync server's relay, as createDocOfDatatype2 does
  if (hive && isKeyhiveDoc(handle.url)) await hive.addSyncServerRelayToDoc(handle.url);
  handle.change((doc) => {
    datatype.module.init(doc, repo);
    doc["@patchwork"] = { type: datatype.id };
    change?.(doc);
  });
  return handle;
}

// a doc, or undefined if it can't be found in a while
export async function findSoon(repo, url, ms = 15000) {
  let timer;
  try {
    const later = new Promise((_, reject) => (timer = setTimeout(reject, ms)));
    return (await Promise.race([repo.find(url), later])).doc() ?? undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// a new doc, with the sync server's relay if it's a keyhive one (as
// createDocOfDatatype2 does)
export async function createDoc(repo, value, hive) {
  const handle = await repo.create2(value);
  if (hive && isKeyhiveDoc(handle.url)) await hive.addSyncServerRelayToDoc(handle.url);
  return handle;
}

// what a folder or a directory calls a doc it links to, and its type
export async function describeDoc(url, repo) {
  const doc = await findSoon(repo, url);
  const type = doc?.["@patchwork"]?.type;
  const datatype = await loadDatatype(type == null ? undefined : String(type));
  const name = doc?.name ?? doc?.title ?? datatype?.module.getTitle?.(doc);
  return { name: name == null ? "" : String(name), type: type == null ? "file" : String(type) };
}
