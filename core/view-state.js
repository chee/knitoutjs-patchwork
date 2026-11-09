// what's going on in each pane past the doc it shows: what's selected, how
// far in it's zoomed, where a playhead is. lattice answers
// patchwork:view-state for anything in one of its panes with a url, and
// that's a doc like any other to whoever asked: they find it with their repo
// and read it, change it, and hear its changes. it's in the realm's scratch
// repo, so it's never saved or synced: lattice answers repo:handle-descriptor
// for it, so a view of it reads and writes the scratch doc. while you follow
// someone it's a copy of theirs instead, kept up to date, till you stop; a
// tool hears a change either way (scopeReplaced), and reads it again.
// what's in yours goes to everyone else in the room as it changes (see
// latticework.js), and theirs come back the same way
import * as providers from "@inkandswitch/patchwork-providers";
import { parseAutomergeUrl } from "@automerge/automerge-repo/slim";

// a pane is a view, as a <patchwork-view> is: what a tool in one asks for
// starts at the pane, so lattice hears it before anything further up does
export const PANE_TAG = "lattice-pane";
providers.registerPatchworkViewTag(PANE_TAG);

// a repo for a pane's tool: it asks from the pane, as a <patchwork-view>'s
// does from that, for whatever it finds
export function paneRepo(baseRepo, pane) {
  return new providers.OverlayRepo(baseRepo.baseRepo ?? baseRepo, pane);
}

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// `source` (plain) written over `target` (a doc being changed), touching only
// what differs. lists go whole
export function copyInto(target, source) {
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isObject(value) && isObject(target[key])) copyInto(target[key], value);
    else if (!same(target[key], value)) target[key] = value;
  }
}

/**
 * answer patchwork:view-state for what's in a pane under `element`.
 * `paneOf(event)` is the id of the pane the asker's in, or null. `room` is
 * the project's files: a view-state doc's peer traffic (broadcast,
 * ephemeral messages) goes there, as it has no peers of its own.
 * `onChange(id)` hears that a pane's own view state changed.
 * returns:
 *   follow(id, state): show `state` (someone's view state) in that pane
 *     instead of yours; null for yours again
 *   docOf(id): your view state in that pane, plain, or null
 *   forget(id): the pane's gone
 *   stop()
 */
export function provideViewState(element, { room, paneOf, onChange }) {
  // providers from before the scratch repo would show a view of a pane's url
  // the doc its descriptor stands for (the room) in place of the scratch one
  if (typeof providers.getScratchRepo !== "function") {
    return { follow() {}, docOf: () => null, forget() {}, stop() {} };
  }
  const scratch = providers.getScratchRepo();
  // by pane id: {mine, copy, showing, descriptors, off}. mine's url is the
  // one the tool is given, whichever doc is showing under it
  const panes = new Map();
  const byDoc = new Map();
  // while following, what each pane should show of theirs
  const wanted = new Map();

  const descriptor = (pane) => ({
    url: pane.mine.url,
    cloneUrl: room.url,
    scratchUrl: pane.showing.url,
  });

  function show(pane, theirs) {
    let next = pane.mine;
    if (theirs) {
      pane.copy ??= scratch.create({});
      pane.copy.change((doc) => copyInto(doc, theirs));
      next = pane.copy;
    }
    if (next === pane.showing) return;
    pane.showing = next;
    for (const respond of pane.descriptors) respond(descriptor(pane));
  }

  function paneFor(id) {
    let pane = panes.get(id);
    if (pane) return pane;
    const mine = scratch.create({});
    pane = { id, mine, copy: null, showing: mine, descriptors: new Set() };
    const changed = () => onChange(id);
    mine.on("change", changed);
    pane.off = () => mine.off("change", changed);
    panes.set(id, pane);
    byDoc.set(mine.documentId, pane);
    show(pane, wanted.get(id) ?? null);
    return pane;
  }

  function onSubscribe(event) {
    const selector = event.detail?.selector;
    if (selector?.type === "patchwork:view-state") {
      const id = paneOf(event);
      if (id) providers.accept(event, (respond) => respond(paneFor(id).mine.url));
      return;
    }
    if (selector?.type !== "repo:handle-descriptor") return;
    let documentId;
    try {
      documentId = parseAutomergeUrl(selector.url).documentId;
    } catch {
      return;
    }
    const pane = byDoc.get(documentId);
    if (!pane) return;
    providers.accept(event, (respond) => {
      pane.descriptors.add(respond);
      respond(descriptor(pane));
      return () => pane.descriptors.delete(respond);
    });
  }
  element.addEventListener("patchwork:subscribe", onSubscribe);

  function forget(id) {
    wanted.delete(id);
    const pane = panes.get(id);
    if (!pane) return;
    pane.off();
    panes.delete(id);
    byDoc.delete(pane.mine.documentId);
    scratch.delete(pane.mine.url);
    if (pane.copy) scratch.delete(pane.copy.url);
  }

  return {
    follow(id, theirs) {
      if (theirs) wanted.set(id, theirs);
      else wanted.delete(id);
      const pane = panes.get(id);
      if (pane) show(pane, theirs);
    },
    docOf(id) {
      const doc = panes.get(id)?.mine.doc();
      return doc ? JSON.parse(JSON.stringify(doc)) : null;
    },
    forget,
    stop() {
      element.removeEventListener("patchwork:subscribe", onSubscribe);
      for (const id of [...panes.keys()]) forget(id);
    },
  };
}
