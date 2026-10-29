import { createStore, unwrap } from "solid-js/store";

// how each .js's builds are going, for the whole frame: its editor builds it
// (by hand, or by itself with autobuild on) and says so here, so the panes
// showing the .k it writes can say so too. keyed by the .js's url:
// { state: "idle" | "running" | "ok" | "error" | "ask", line?, message?,
//   auto, builder?: { now(), goToLine(line) } }
// there's only a builder while that .js is open in an editor
const [builds, setBuilds] = createStore({});

export { builds };

export function setBuild(url, build) {
  setBuilds(url, build);
}

// the builder itself, not the store's stand-in for it, to tell whose it is
export function builderOf(url) {
  return unwrap(builds)[url]?.builder;
}
