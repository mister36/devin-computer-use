import assert from "node:assert/strict";
import test from "node:test";

import { diffTrees, elementKey, formatTree } from "../src/tree.mjs";

const state = (elements, extra = {}) => ({
  app: { pid: 42, name: "Notes", bundleId: "com.apple.Notes" },
  window: { id: 7, title: "Groceries", bounds: [0, 0, 800, 600] },
  elements,
  ...extra,
});

test("formats a full tree with header and indented elements", () => {
  const text = formatTree(state([
    { id: 3, role: "toolbar", label: null, value: null, depth: 0 },
    { id: 4, role: "button", label: "New Note", depth: 1 },
    { id: 7, role: "textfield", label: "Search", value: "", depth: 1 },
    { id: 12, role: "textarea", label: "Note body", value: "milk\neggs", depth: 0, focused: true },
  ]));
  const lines = text.split("\n");
  assert.equal(lines[0], 'window: Notes — "Groceries" (4 elements, full)');
  assert.equal(lines[1], "[3] toolbar");
  assert.equal(lines[2], '  [4] button "New Note"');
  assert.equal(lines[3], '  [7] textfield "Search"');
  assert.equal(lines[4], '[12] textarea "Note body" value="milk\\neggs" focused');
});

test("marks truncated state in the header", () => {
  const text = formatTree(state([], { truncated: true }));
  assert.match(text, /\(0 elements, full, truncated\)/);
});

test("elementKey includes role, label and labelled ancestor path", () => {
  const elements = [
    { id: 1, role: "group", label: "Sidebar", depth: 0 },
    { id: 2, role: "button", label: "Share", depth: 1 },
    { id: 3, role: "button", label: "Share", depth: 0 },
  ];
  assert.notEqual(elementKey(elements[1], elements), elementKey(elements[2], elements));
  assert.equal(
    elementKey(elements[1], elements),
    "button|Share|group:Sidebar",
  );
});

test("diffs added, removed and changed elements", () => {
  const prev = state([
    { id: 12, role: "textarea", label: "Note body", value: "milk\neggs", depth: 0 },
    { id: 20, role: "button", label: "Delete", depth: 0 },
  ]);
  const next = state([
    { id: 30, role: "textarea", label: "Note body", value: "milk\neggs\nbread", depth: 0 },
    { id: 88, role: "text", label: "Saved", depth: 0 },
  ]);
  const lines = formatTree(next, { diffAgainst: prev }).split("\n");
  assert.equal(lines[0], 'window: Notes — "Groceries" (2 elements, diff vs previous)');
  assert.deepEqual(lines.slice(1), [
    '- [12] textarea "Note body" value="milk\\neggs"',
    '~ [30] textarea "Note body" value="milk\\neggs\\nbread"',
    '+ [88] text "Saved"',
    '- [20] button "Delete"',
  ]);
});

test("identical trees produce a no-changes diff", () => {
  const a = state([
    { id: 1, role: "button", label: "OK", depth: 0 },
  ]);
  const b = state([
    { id: 9, role: "button", label: "OK", depth: 0 },
  ]);
  const lines = formatTree(b, { diffAgainst: a }).split("\n");
  assert.deepEqual(lines.slice(1), ["(no changes)"]);
});

test("diff ignores ids since keys are role+label+path", () => {
  const prev = state([{ id: 1, role: "button", label: "OK", depth: 0 }]);
  const next = state([{ id: 99, role: "button", label: "OK", depth: 0 }]);
  assert.deepEqual(diffTrees(prev, next), []);
});
