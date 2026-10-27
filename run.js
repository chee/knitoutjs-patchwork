import * as Automerge from "@automerge/automerge";
import { javascriptLanguage } from "./vendor/codemirror.js";
import { evalJS } from "./vendor/evalJS.js";
import { docText } from "./files.js";

// every loop in a pattern gets a turn counter, so an infinite loop stops with
// a message instead of freezing the page
export const LOOP_BUDGET = 10_000_000;
export const TIME_BUDGET = 10_000;

export class LoopBudgetError extends Error {
  constructor(line, reason) {
    super(
      reason === "time"
        ? `stopped after ${TIME_BUDGET / 1000}s in the loop on line ${line}. is it infinite?`
        : `stopped after ${LOOP_BUDGET.toLocaleString()} loop turns, in the loop on line ${line}. is it infinite?`,
    );
    this.line = line;
  }
}

function loopBody(node) {
  // do Statement while (...)
  if (node.name === "DoStatement") return node.firstChild?.nextSibling;
  // for (...) Statement, while (...) Statement
  return node.lastChild;
}

// wrap every loop body as `{__loop(line); body}`. nothing is added on new
// lines, so line numbers (and the ;!source: lines) still match the editor
export function budgetLoops(code) {
  const tree = javascriptLanguage.parser.parse(code);
  const inserts = [];
  tree.iterate({
    enter(node) {
      if (
        node.name !== "ForStatement" &&
        node.name !== "WhileStatement" &&
        node.name !== "DoStatement"
      ) {
        return;
      }
      const body = loopBody(node.node);
      if (!body || body.type.isError) return;
      const line = code.slice(0, node.from).split("\n").length;
      inserts.push({ at: body.from, text: `{__loop(${line});` });
      inserts.push({ at: body.to, text: "}" });
    },
  });
  // from the end, so earlier positions stay put. a body's closing brace and a
  // nested body's closing brace can share a position; either order is fine
  inserts.sort((a, b) => b.at - a.at);
  for (const { at, text } of inserts) {
    code = code.slice(0, at) + text + code.slice(at);
  }
  return code;
}

function createLoopCounter() {
  const start = performance.now();
  let turns = 0;
  return function __loop(line) {
    turns++;
    if (turns > LOOP_BUDGET) throw new LoopBudgetError(line, "turns");
    if ((turns & 0xffff) === 0 && performance.now() - start > TIME_BUDGET) {
      throw new LoopBudgetError(line, "time");
    }
  };
}

// run a knitout.js pattern: {knitout, error, ms}. the pattern can use
// `repo` to find other docs
export async function compile(code, { repo } = {}) {
  const start = performance.now();
  let error = null;
  let budgeted;
  try {
    budgeted = budgetLoops(code);
  } catch (e) {
    budgeted = code;
  }
  const knitout = await evalJS(budgeted, {
    globals: { __loop: createLoopCounter(), repo },
    onError: (e) => (error = e),
  });
  return { knitout, error, ms: performance.now() - start };
}

// run the .js handle's code and write the knitout into the .k handle,
// remembering on each side who it's linked to
export async function runInto(jsHandle, kHandle, repo) {
  const result = await compile(docText(jsHandle.doc()), { repo });
  if (result.error && !result.knitout) return result;
  kHandle.change((doc) => {
    if (typeof doc.content === "string") {
      Automerge.updateText(doc, ["content"], result.knitout);
    } else {
      doc.content = result.knitout;
    }
    doc.knitoutSource = jsHandle.url;
  });
  if (jsHandle.doc()?.knitoutTarget !== kHandle.url) {
    jsHandle.change((doc) => {
      doc.knitoutTarget = kHandle.url;
    });
  }
  return result;
}
