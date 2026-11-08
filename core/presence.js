// who else is in a project, and how their panes look. it goes over the
// ephemeral channel of the project's files (its folder or directory), so
// everyone with those files open is here, whichever project of them they're
// in and whichever draft. automerge-repo's Presence carries it: each
// person's name, colour and face, their layout's nodes, and which tab each
// of its groups shows. nothing's kept: it's gone when they go
import { Presence, isValidAutomergeUrl } from "@automerge/automerge-repo/slim";

const HEARTBEAT = 2000;
const TTL = 10000;
// Presence forgets anyone it's only had heartbeats from for TTL, so what we
// have goes out again this often
const AGAIN = 3000;
const EVENTS = ["update", "snapshot", "goodbye", "pruned"];

const string = (value) => (value == null ? "" : String(value));
const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

// a face's picture: the avatar doc, through patchwork's service worker. if
// that isn't to be had, faces are initials
let avatarSrc = null;
import("@inkandswitch/patchwork-filesystem").then(
  (filesystem) => (avatarSrc = filesystem.automergeUrlToServiceWorkerUrl),
  () => {},
);
export function faceImage(url) {
  try {
    return url && avatarSrc ? avatarSrc(url) : null;
  } catch {
    return null;
  }
}

// what someone sent, checked: nodes are objects by id, active is group id →
// panel id. anything else is dropped
function nodesFrom(value) {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, node]) => isObject(node)));
}
function activeFrom(value) {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([group, panel]) => typeof panel === "string" && group),
  );
}

/**
 * join the room on `handle`: the project's files, from the repo under any
 * draft overlay. `onPeople` hears everyone else whenever that changes:
 * [{peer, name, colour, avatar, nodes, active}], one each (their tab that
 * did something last). `repo` finds who you are (your account's contact).
 * returns {share(channel, value), stop()}: share sends "nodes" or "active"
 */
export function joinRoom(handle, repo, onPeople) {
  const presence = new Presence({ handle });
  const state = { contact: "", name: "anonymous", colour: "", avatar: "", nodes: {}, active: {} };
  let dead = false;

  function people() {
    const byWho = new Map();
    for (const peer of presence.getPeerStates().peers) {
      const value = peer.value ?? {};
      const who = string(value.contact) || string(peer.peerId);
      if (state.contact && who === state.contact) continue;
      const had = byWho.get(who);
      if (!had || peer.lastActiveAt > had.lastActiveAt) byWho.set(who, peer);
    }
    return [...byWho.values()].map(({ peerId, value = {} }) => ({
      peer: string(peerId),
      name: string(value.name) || "anonymous",
      colour: string(value.colour),
      avatar: string(value.avatar),
      nodes: nodesFrom(value.nodes),
      active: activeFrom(value.active),
    }));
  }
  const tell = () => !dead && onPeople(people());
  for (const event of EVENTS) presence.on(event, tell);

  function share(channel, value) {
    state[channel] = value;
    if (presence.running) presence.broadcast(channel, value);
  }

  presence.start({ initialState: { ...state }, heartbeatMs: HEARTBEAT, peerTtlMs: TTL });
  const again = setInterval(() => presence.broadcast("at", Date.now()), AGAIN);

  // who you are: your account's contact, kept up to date
  let contact = null;
  const readContact = () => {
    const doc = contact?.doc();
    if (!doc) return;
    const registered = doc.type === "registered";
    share("name", (registered && string(doc.name)) || "anonymous");
    share("colour", string(doc.color));
    share("avatar", (registered && string(doc.avatarUrl)) || "");
    tell();
  };
  const contactUrl = string(globalThis.accountDocHandle?.doc()?.contactUrl);
  if (isValidAutomergeUrl(contactUrl)) {
    share("contact", contactUrl);
    repo.find(contactUrl).then(
      (handle) => {
        if (dead) return;
        contact = handle;
        contact.on("change", readContact);
        readContact();
      },
      () => {},
    );
  }

  return {
    share,
    stop() {
      dead = true;
      clearInterval(again);
      contact?.off("change", readContact);
      for (const event of EVENTS) presence.off(event, tell);
      presence.stop();
    },
  };
}
