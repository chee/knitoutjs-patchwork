import { ImmutableString } from "@automerge/automerge";
import { parser } from "./vendor/lezer-javascript.js";
import { docText, moduleWorker, textHash } from "./files.js";

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
// - every `import(x)` becomes `__import(line, x)`. left alone, `/automerge:…`
//   would be found next to evalJS.js (wherever these panes are hosted), not
//   on the page's own site, where the service worker hands out docs
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
      } else if (node.name === "DynamicImport") {
        const keyword = node.node.firstChild;
        const paren = keyword?.nextSibling;
        if (keyword?.name !== "import" || paren?.name !== "(") return;
        const line = lineAt(node.from);
        inserts.push({ at: keyword.from, text: "__", depth, open: true });
        inserts.push({ at: paren.to, text: `${line}, `, depth, open: true });
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
  // where several land on one spot, the outer one goes in front when opening
  // and behind when closing
  inserts.sort(
    (a, b) =>
      a.at - b.at ||
      (a.open === b.open ? (a.open ? a.depth - b.depth : b.depth - a.depth) : a.open ? 1 : -1),
  );

  // put together front to back, keeping a source map as we go: nothing
  // added has a newline, so each line maps to the same line, and only the
  // columns move. the code's own text gets a mapping at every token (a
  // mapping covers everything up to the next one, so fewer would land a
  // breakpoint at the wrong spot); added text maps to where it was added
  const lines = [[]];
  let out = "";
  let line = 0;
  let lineStart = 0;
  let generated = 0;
  const map = (from) => lines[line].push([generated, line, from - lineStart]);
  function original(from, to) {
    for (const piece of code.slice(from, to).split(/(\n)/)) {
      if (piece === "\n") {
        out += "\n";
        lines.push([]);
        line++;
        lineStart = from + 1;
        generated = 0;
        from++;
        continue;
      }
      for (const token of piece.matchAll(/[\w$]+|\S/g)) {
        lines[line].push([generated + token.index, line, from + token.index - lineStart]);
      }
      out += piece;
      generated += piece.length;
      from += piece.length;
    }
  }
  let at = 0;
  for (const insert of inserts) {
    original(at, insert.at);
    at = insert.at;
    map(at);
    out += insert.text;
    generated += insert.text.length;
  }
  original(at, code.length);

  return { code: out, mappings: encodeMappings(lines) };
}

// a source map's mappings, from [generated column, original line, original
// column] per line. each number is relative to the one before it, in base64
// vlq
function encodeMappings(lines) {
  const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function vlq(n) {
    let value = n < 0 ? (-n << 1) | 1 : n << 1;
    let text = "";
    do {
      let digit = value & 31;
      value >>>= 5;
      if (value) digit |= 32;
      text += BASE64[digit];
    } while (value);
    return text;
  }
  let lastLine = 0;
  let lastColumn = 0;
  return lines
    .map((segments) => {
      let lastGenerated = 0;
      return segments
        .map(([generated, line, column]) => {
          const text =
            vlq(generated - lastGenerated) + "A" + vlq(line - lastLine) + vlq(column - lastColumn);
          lastGenerated = generated;
          lastLine = line;
          lastColumn = column;
          return text;
        })
        .join(",");
    })
    .join(";");
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
export function compile(code, { repo, signal, name } = {}) {
  const start = performance.now();
  let budgeted;
  let sourceMap = null;
  try {
    const instrumented = instrument(code);
    budgeted = instrumented.code;
    // so devtools shows (and steps through) the pattern as it was written
    sourceMap = {
      version: 3,
      sources: [name || "pattern.knitout.js"],
      sourcesContent: [code],
      names: [],
      mappings: instrumented.mappings,
    };
  } catch {
    budgeted = code;
  }

  return new Promise((resolve) => {
    const worker = moduleWorker(WORKER_URL);
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
      sourceMap,
      // where the pattern's imports are found from: the page, not this file
      base: location.href,
      loopBudget: LOOP_BUDGET,
      timeBudget: TIME_BUDGET,
    });
  });
}

// run the .js handle's code and write the knitout into the .k handle,
// remembering on each side who it's linked to, and on the .k when it was
// built and from what code (so it can tell when it's out of date). the
// knitout goes in as an ImmutableString: writing a big one as editable text
// is slow, and a generated .k isn't for typing into (make an editable copy
// for that)
export async function runInto(jsHandle, kHandle, repo, { signal } = {}) {
  const code = docText(jsHandle.doc());
  const result = await compile(code, { repo, signal, name: jsHandle.doc()?.name });
  // a build that failed leaves the .k as it was
  if (result.error) return result;
  kHandle.change((doc) => {
    doc.content = new ImmutableString(result.knitout);
    doc.knitoutSource = jsHandle.url;
    doc.knitoutSourceHash = textHash(code);
    doc.knitoutBuiltAt = Date.now();
  });
  if (jsHandle.doc()?.knitoutTarget !== kHandle.url) {
    jsHandle.change((doc) => {
      doc.knitoutTarget = kHandle.url;
    });
  }
  return result;
}
