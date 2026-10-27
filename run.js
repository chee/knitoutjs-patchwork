import { ImmutableString } from "@automerge/automerge";
import { parser } from "./vendor/lezer-javascript.js";
import { docText } from "./files.js";

// patterns run in a worker (run-worker.js), so the page never waits on them.
// every loop gets a turn counter, so a loop that never ends stops with the
// line it's on; past the time budget, the worker is stopped regardless
export const LOOP_BUDGET = 10_000_000;
export const TIME_BUDGET = 5_000;
const HARD_STOP = TIME_BUDGET + 1_500;

const WORKER_URL = new URL("./run-worker.js", import.meta.url);

function loopBody(node) {
  // do Statement while (...)
  if (node.name === "DoStatement") return node.firstChild?.nextSibling;
  // for (...) Statement, while (...) Statement
  return node.lastChild;
}

// what a call is called on: `k` in `k.knit()`, `foo` in `foo()`
function callTarget(call) {
  const callee = call.firstChild;
  if (!callee) return null;
  if (callee.name === "MemberExpression") return callee.firstChild;
  return callee;
}

// two things are added to a pattern before it runs, all on the lines they
// belong to, so line numbers (and the ;!source: lines) still match the editor:
// - every loop body becomes `{__loop(line); body}`, to count its turns
// - every call notes its line, `k.knit(…)` → `__at(line, k).knit(…)`, so a
//   stitch knows where it came from even where stack traces don't say
//   (safari). `__at` hands back what it's given, so `this` is unchanged
export function instrument(code) {
  const tree = parser.parse(code);
  const lineAt = (pos) => code.slice(0, pos).split("\n").length;
  const inserts = [];
  let depth = 0;
  tree.iterate({
    enter(node) {
      depth++;
      if (
        node.name === "ForStatement" ||
        node.name === "WhileStatement" ||
        node.name === "DoStatement"
      ) {
        const body = loopBody(node.node);
        if (!body || body.type.isError) return;
        const line = lineAt(node.from);
        inserts.push({ at: body.from, text: `{__loop(${line});`, depth, open: true });
        inserts.push({ at: body.to, text: "}", depth, open: false });
      } else if (node.name === "CallExpression") {
        const target = callTarget(node.node);
        const text = target && code.slice(target.from, target.to);
        if (!target || target.type.isError || text === "super" || text === "import") return;
        inserts.push({ at: target.from, text: `__at(${lineAt(node.from)}, `, depth, open: true });
        inserts.push({ at: target.to, text: ")", depth, open: false });
      }
    },
    leave() {
      depth--;
    },
  });
  // applied from the end, so earlier positions stay put. where several land
  // on one spot, the outer one has to end up in front when opening and
  // behind when closing
  inserts.sort(
    (a, b) =>
      b.at - a.at ||
      (a.open === b.open ? (a.open ? b.depth - a.depth : a.depth - b.depth) : a.open ? -1 : 1),
  );
  for (const { at, text } of inserts) {
    code = code.slice(0, at) + text + code.slice(at);
  }
  return code;
}

// where the code first stops making sense, for syntax errors (the engine
// doesn't say which line)
function firstBrokenLine(code) {
  let at = null;
  parser.parse(code).iterate({
    enter(node) {
      if (at !== null) return false;
      if (node.type.isError) at = node.from;
    },
  });
  return at === null ? null : code.slice(0, at).split("\n").length;
}

// a plain copy of a doc, to hand to the worker
function snapshot(doc) {
  return JSON.parse(JSON.stringify(doc ?? null));
}

// run a knitout.js pattern: {knitout, error, ms}. the pattern can use
// `repo.find(url)` to read other docs. aborting `signal` stops it
export function compile(code, { repo, signal } = {}) {
  const start = performance.now();
  let budgeted;
  try {
    budgeted = instrument(code);
  } catch {
    budgeted = code;
  }

  return new Promise((resolve) => {
    const worker = new Worker(WORKER_URL, { type: "module" });
    let timer;

    function finish(knitout, error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      resolve({ knitout, error, ms: performance.now() - start });
    }

    function onAbort() {
      finish("", { message: "stopped", stopped: true });
    }

    worker.onmessage = async ({ data }) => {
      if (data.type === "done") {
        const error = data.error;
        if (error?.syntax && error.line == null) error.line = firstBrokenLine(code);
        finish(data.knitout, error);
      } else if (data.type === "find") {
        try {
          const doc = (await repo.find(data.url)).doc();
          worker.postMessage({ type: "doc", id: data.id, doc: snapshot(doc) });
        } catch (error) {
          worker.postMessage({ type: "missing", id: data.id, message: String(error?.message ?? error) });
        }
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish("", { message: event.message || "the pattern's worker didn't start" });
    };

    timer = setTimeout(
      () => finish("", { message: `stopped after ${HARD_STOP / 1000}s. is something looping forever?` }),
      HARD_STOP,
    );
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);

    worker.postMessage({
      type: "run",
      code: budgeted,
      loopBudget: LOOP_BUDGET,
      timeBudget: TIME_BUDGET,
    });
  });
}

// run the .js handle's code and write the knitout into the .k handle,
// remembering on each side who it's linked to. the knitout goes in as an
// ImmutableString: writing a big one as editable text is slow, and a
// generated .k isn't for typing into (make an editable copy for that)
export async function runInto(jsHandle, kHandle, repo, { signal } = {}) {
  const result = await compile(docText(jsHandle.doc()), { repo, signal });
  // a run that failed leaves the .k as it was
  if (result.error) return result;
  kHandle.change((doc) => {
    doc.content = new ImmutableString(result.knitout);
    doc.knitoutSource = jsHandle.url;
  });
  if (jsHandle.doc()?.knitoutTarget !== kHandle.url) {
    jsHandle.change((doc) => {
      doc.knitoutTarget = kHandle.url;
    });
  }
  return result;
}
