// who else is in a project, and how their panes look. it goes over the
// ephemeral channel of the project's files (its folder or directory), so
// everyone with those files open is here, whichever project of them they're
// in and whichever draft. automerge-repo's Presence carries it: each
// person's name, colour and face, their layout's nodes, and which tab each
// of its groups shows, and their pointer: where it is, over which doc, and
// whether it's an arrow or a mouse. nothing's kept: it's gone when they go
//
// arriving, you say hello: you ask everyone there for all of what they have,
// a few times, since the folder may not be syncing yet when you first ask.
// and you ask again whenever someone's only partly heard (back after being
// away, say, when all that's come is that they're still here)
import { Presence, isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import { colourFor } from "./pointer.js";

const HEARTBEAT = 2000;
const TTL = 10000;
// Presence forgets anyone it's only had heartbeats from for TTL, so what we
// have goes out again this often
const AGAIN = 3000;
const EVENTS = ["update", "snapshot", "goodbye", "pruned"];
// asking for hello, as you arrive: this long after, each time
const ARRIVING = [0, 1000, 3000, 8000];
// and not more often than this otherwise
const ASK_EVERY = 2000;
// many asking at once get one answer
const ANSWER_AFTER = 100;
const HELLO = "latticework:hello?";

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
// a pointer: over the doc at `url`, in `tool`, at x, y (fractions of the
// pane it's in: a little past its edges, over its tabs, say)
function pointerFrom(value) {
  if (!isObject(value) || !isValidAutomergeUrl(string(value.url))) return null;
  const { x, y } = value;
  if (![x, y].every((n) => typeof n === "number" && n >= -1 && n <= 2)) return null;
  return { url: string(value.url), tool: string(value.tool), x, y };
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
 * [{peer, name, colour, avatar, nodes, active, pointer, look}], one each
 * (their tab that did something last). colour is their pointer's: their
 * contact's, or else one for them from the palette. `repo` finds who you are
 * (your account's contact). returns {share(channel, value), stop()}: share
 * sends "nodes", "active", "pointer" ({url, tool, x, y}, or null) or "look"
 * ("arrow" or "mouse")
 */
export function joinRoom(handle, repo, onPeople) {
  const presence = new Presence({ handle });
  const state = {
    contact: "",
    name: "anonymous",
    colour: "",
    avatar: "",
    nodes: {},
    active: {},
    pointer: null,
    look: "arrow",
  };
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
    return [...byWho.entries()].map(([who, { peerId, value = {} }]) => ({
      peer: string(peerId),
      name: string(value.name) || "anonymous",
      colour: string(value.colour) || colourFor(who),
      avatar: string(value.avatar),
      nodes: nodesFrom(value.nodes),
      active: activeFrom(value.active),
      pointer: pointerFrom(value.pointer),
      look: value.look === "mouse" ? "mouse" : "arrow",
    }));
  }
  // anyone heard of only partly (no contact yet: everyone sends one, if only
  // "") is asked for the rest
  const partly = () =>
    presence.getPeerStates().peers.some((peer) => !("contact" in (peer.value ?? {})));
  const tell = () => {
    if (dead) return;
    if (partly()) ask();
    onPeople(people());
  };
  for (const event of EVENTS) presence.on(event, tell);

  // hello: asking everyone for all they have, and answering when asked
  let asked = 0;
  function ask({ now = false } = {}) {
    if (dead || (!now && Date.now() - asked < ASK_EVERY)) return;
    asked = Date.now();
    handle.broadcast({ [HELLO]: true });
  }
  let answering = null;
  function onHello(event) {
    if (dead || !event.message?.[HELLO] || answering) return;
    answering = setTimeout(() => {
      answering = null;
      if (!dead && presence.running) presence.broadcastLocalState();
    }, ANSWER_AFTER);
  }
  handle.on("ephemeral-message", onHello);

  function share(channel, value) {
    state[channel] = value;
    if (presence.running) presence.broadcast(channel, value);
  }

  presence.start({ initialState: { ...state }, heartbeatMs: HEARTBEAT, peerTtlMs: TTL });
  const again = setInterval(() => presence.broadcast("at", Date.now()), AGAIN);
  const arriving = ARRIVING.map((after) => setTimeout(() => ask({ now: true }), after));

  // back from being away (a hidden tab's timers barely run, so others may
  // have forgotten you): all of yours again, and all of theirs
  function onVisible() {
    if (document.visibilityState !== "visible" || dead) return;
    presence.broadcastLocalState();
    ask({ now: true });
  }
  document.addEventListener("visibilitychange", onVisible);

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
      arriving.forEach(clearTimeout);
      clearTimeout(answering);
      handle.off("ephemeral-message", onHello);
      document.removeEventListener("visibilitychange", onVisible);
      contact?.off("change", readContact);
      for (const event of EVENTS) presence.off(event, tell);
      presence.stop();
    },
  };
}
