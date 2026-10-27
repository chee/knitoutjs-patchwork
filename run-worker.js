import { evalJS } from "./vendor/evalJS.js";

// runs one knitout.js pattern off the page's thread, so a pattern that never
// ends can't freeze anything: the page just stops this worker.
//
// in:  {type: "run", code, loopBudget, timeBudget}   (loops already counted)
//      {type: "doc", id, doc} | {type: "missing", id, message}
// out: {type: "done", knitout, error: {message, line} | null}
//      {type: "find", id, url}

let asked = 0;
const waiting = new Map();

// enough of a repo for `await repo.find(url)`: a snapshot of the doc, read only
const repo = {
  find(url) {
    const id = ++asked;
    postMessage({ type: "find", id, url });
    return new Promise((resolve, reject) => waiting.set(id, { url, resolve, reject }));
  },
};

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
  if (data.type === "doc" || data.type === "missing") {
    const asking = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.type === "doc") {
      asking?.resolve({ url: asking.url, isReady: () => true, doc: () => data.doc });
    } else {
      asking?.reject(new Error(data.message));
    }
    return;
  }
  if (data.type !== "run") return;
  let error = null;
  let line = null;
  const __at = (at, value) => ((line = at), value);
  const knitout = await evalJS(data.code, {
    globals: { __loop: loopCounter(data.loopBudget, data.timeBudget), __at, repo },
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
