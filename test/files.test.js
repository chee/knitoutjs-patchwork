import { test } from "node:test";
import assert from "node:assert/strict";
import { withExtension } from "../core/files.js";

test("a name without an extension gets the doc's", () => {
  assert.equal(withExtension("pattern", "k"), "pattern.k");
  assert.equal(withExtension("kniterate", "machine"), "kniterate.machine");
  assert.equal(withExtension("notes", ".md"), "notes.md");
});

test("a name with an extension of its own keeps it", () => {
  assert.equal(withExtension("pattern.knitout.js", "js"), "pattern.knitout.js");
  assert.equal(withExtension("scarf.k", "k"), "scarf.k");
  assert.equal(withExtension("draft.txt", "md"), "draft.txt");
});

test("nothing to add, nothing added", () => {
  assert.equal(withExtension("pattern", ""), "pattern");
  assert.equal(withExtension("", "k"), "");
});
