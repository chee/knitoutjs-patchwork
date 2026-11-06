import { evalJS } from "./vendor/evalJS.js";

// runs one knitout.js pattern off the page's thread, so a pattern that never
// ends can't freeze anything: the page just stops this worker.
//
// in:  {type: "run", code, sourceMap, base, loopBudget, timeBudget, automerge}
//      (loops already counted; sourceMap leads back to the code as written;
//      automerge says where to load the Repo from, see compile in run.js)
// out: {type: "connect", port}   a port for the window's Repo to sync over
//      {type: "started"}         the Repo is up, the pattern is running
//      {type: "done", knitout, error: {message, line} | null}

// a Repo of our own, with the window's Repo as its only peer: subduction over
// a MessageChannel. nothing stored here; everything comes from the window,
// which has the sync server. a worker has no import map, so the page says
// where the modules and wasm are
let started;
function startRepo({ modules, wasm, service }) {
  started ??= (async () => {
    const [{ initializeWasm }, subduction, { Repo }] = await Promise.all([
      import(modules.automerge),
      import(modules.subduction),
      import(modules.repo),
    ]);
    await Promise.all([
      initializeWasm(new Request(wasm.automerge)),
      subduction.default(new Request(wasm.subduction)),
    ]);
    return new Repo({
      subductionWebsocketEndpoints: [windowEndpoint(service, subduction.MessagePortTransport)],
    });
  })();
  return started;
}

// what the Repo's reconnect loop connects to: each time, a fresh channel, one
// end to the page (which accepts on it) and one end here
function windowEndpoint(service, MessagePortTransport) {
  return {
    // the reconnect loop takes this url's host as the service name
    url: `knitout://${service}`,
    async connect() {
      const { port1, port2 } = new MessageChannel();
      postMessage({ type: "connect", port: port2 }, [port2]);
      const transport = new MessagePortTransport(port1);
      let hungUp;
      const closed = new Promise((resolve) => (hungUp = resolve));
      let then = () => {};
      transport.onDisconnect(() => {
        hungUp();
        then();
      });
      return {
        sendBytes: (bytes) => transport.sendBytes(bytes),
        recvBytes: () => transport.recvBytes(),
        disconnect: () => transport.disconnect(),
        onDisconnect: (callback) => (then = callback),
        closed: () => closed,
      };
    },
  };
}

function loopCounter(loopBudget, timeBudget) {
  const start = performance.now();
  let turns = 0;
  return function __loop(line) {
    turns++;
    if (turns > loopBudget) {
      throw Object.assign(
        new Error(`stopped after ${loopBudget.toLocaleString()} loop turns, in the loop on line ${line}. is it infinite?`),
        { line },
      );
    }
    if ((turns & 0x3ff) === 0 && performance.now() - start > timeBudget) {
      throw Object.assign(
        new Error(`stopped after ${timeBudget / 1000}s in the loop on line ${line}. is it infinite?`),
        { line },
      );
    }
  };
}

onmessage = async ({ data }) => {
  if (data.type !== "run") return;
  let repo;
  try {
    repo = await startRepo(data.automerge);
  } catch (e) {
    postMessage({
      type: "done",
      knitout: "",
      error: { message: `the pattern's repo didn't start: ${e?.message ?? e}`, line: null },
    });
    return;
  }
  // on the worker's global too, for modules the pattern imports: they're
  // written for a page with a repo on it, and look for it there
  self.repo = repo;
  postMessage({ type: "started" });

  let error = null;
  let line = null;
  const __at = (at, value) => ((line = at), value);
  // `import(x)` in the pattern, found from the page's address
  const __import = (at, specifier) => {
    line = at;
    let url = specifier;
    try {
      url = new URL(specifier, data.base).href;
    } catch {}
    return import(url);
  };
  const knitout = await evalJS(data.code, {
    sourceMap: data.sourceMap,
    globals: { __loop: loopCounter(data.loopBudget, data.timeBudget), __at, __import, repo },
    currentLine: () => line,
    onError: (e, at) =>
      (error = {
        message: String(e?.message ?? e),
        line: e?.line ?? at ?? null,
        syntax: e?.name === "SyntaxError",
      }),
  });
  postMessage({ type: "done", knitout, error });
};
