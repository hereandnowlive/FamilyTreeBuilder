// Tests for the merge planner (src/merge/plan.ts).
//
// Run with `npm test`. They use the test runner built into Node, so there is no test framework to
// install or keep up to date. Node runs TypeScript files directly by stripping the types, which is
// why the import below spells out the ".ts" extension; type-checking is done separately by tsc.
// https://nodejs.org/api/test.html

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlan, isEmptyPlan, type Row, type Snapshot } from "../src/merge/plan.ts";

/** A snapshot with the given tables filled in and the rest empty. */
function snapshot(tables: Partial<Snapshot> = {}): Snapshot {
  return {
    person: [],
    event: [],
    event_participant: [],
    media: [],
    audio: [],
    partnership: [],
    parent_child: [],
    ...tables,
  };
}

function person(id: string, fields: Row = {}): Row {
  return {
    id,
    given_name: id,
    family_name: "",
    sex: "unknown",
    birth_date: "",
    birth_place: "",
    death_date: "",
    death_place: "",
    biography: "",
    portrait_media_id: null,
    ...fields,
  };
}

const parent = (parent_id: string, child_id: string): Row => ({ parent_id, child_id });

test("two identical trees give an empty plan", () => {
  const tree = snapshot({ person: [person("a"), person("b")], parent_child: [parent("a", "b")] });
  const plan = buildPlan(tree, structuredClone(tree));
  assert.ok(isEmptyPlan(plan));
  assert.deepEqual(plan.files, []);
});

test("records only in the file are added, with their files", () => {
  const mine = snapshot({ person: [person("a")] });
  const theirs = snapshot({
    person: [person("a"), person("b")],
    event: [{ id: "e1", person_id: "b", title: "Wedding", event_date: "", description: "" }],
    event_participant: [{ event_id: "e1", person_id: "b" }],
    media: [{ id: "m1", person_id: "b", event_id: "e1", file_name: "photo.jpg", caption: "", description: "" }],
    audio: [{ id: "r1", media_id: "m1", file_name: "voice.mp3", title: "" }],
  });

  const plan = buildPlan(mine, theirs);

  assert.deepEqual(plan.inserts.person.map((row) => row.id), ["b"]);
  assert.deepEqual(plan.inserts.event.map((row) => row.id), ["e1"]);
  assert.deepEqual(plan.inserts.event_participant, [{ event_id: "e1", person_id: "b" }]);
  assert.deepEqual(plan.inserts.media.map((row) => row.id), ["m1"]);
  assert.deepEqual(plan.inserts.audio.map((row) => row.id), ["r1"]);
  assert.deepEqual(plan.files, ["photo.jpg", "voice.mp3"]);
  assert.equal(isEmptyPlan(plan), false);
});

test("records only in the current tree are kept: a merge never deletes", () => {
  const mine = snapshot({ person: [person("a"), person("b")], partnership: [{ id: "p1", person_a_id: "a", person_b_id: "b" }] });
  const plan = buildPlan(mine, snapshot({ person: [person("a")] }));
  assert.ok(isEmptyPlan(plan));
});

test("a blank in the current tree is filled from the file", () => {
  const mine = snapshot({ person: [person("a", { birth_place: "", sex: "unknown" })] });
  const theirs = snapshot({ person: [person("a", { birth_place: "Leeds", sex: "female" })] });

  const plan = buildPlan(mine, theirs);

  // "unknown" counts as blank for sex, so it is filled like an empty field.
  assert.deepEqual(plan.fills, [{ table: "person", id: "a", set: { sex: "female", birth_place: "Leeds" } }]);
  assert.deepEqual(plan.conflicts, []);
});

test("a blank in the file never overwrites a value in the current tree", () => {
  const mine = snapshot({ person: [person("a", { birth_place: "Leeds", sex: "female" })] });
  const theirs = snapshot({ person: [person("a", { birth_place: "  ", sex: "unknown" })] });
  assert.ok(isEmptyPlan(buildPlan(mine, theirs)));
});

test("two different values are a conflict, listing only the fields that differ", () => {
  const mine = snapshot({ person: [person("a", { given_name: "Ada", birth_date: "1850", birth_place: "Leeds" })] });
  const theirs = snapshot({ person: [person("a", { given_name: "Ada", birth_date: "abt. 1851", birth_place: "Leeds" })] });

  const plan = buildPlan(mine, theirs);

  assert.equal(plan.conflicts.length, 1);
  const [conflict] = plan.conflicts;
  assert.equal(conflict.key, "person:a");
  assert.equal(conflict.title, "Ada");
  assert.deepEqual(conflict.theirs, { birth_date: "abt. 1851" });
  assert.deepEqual(conflict.differences, [{ label: "Born", mine: "1850", theirs: "abt. 1851" }]);
  assert.deepEqual(plan.fills, []);
});

test("one record can have a fill and a conflict at once", () => {
  const mine = snapshot({ event: [{ id: "e1", title: "Wedding", event_date: "", description: "" }] });
  const theirs = snapshot({ event: [{ id: "e1", title: "The wedding", event_date: "1902", description: "" }] });

  const plan = buildPlan(mine, theirs);

  assert.deepEqual(plan.fills, [{ table: "event", id: "e1", set: { event_date: "1902" } }]);
  assert.deepEqual(plan.conflicts.map((conflict) => conflict.theirs), [{ title: "The wedding" }]);
});

test("columns the user cannot edit are never compared", () => {
  const mine = snapshot({ person: [person("a", { created_at: "2024-01-01" })] });
  const theirs = snapshot({ person: [person("a", { created_at: "2025-06-06" })] });
  assert.ok(isEmptyPlan(buildPlan(mine, theirs)));
});

test("links that both trees have are not added twice", () => {
  const shared = { person: [person("a"), person("b"), person("c")] };
  const mine = snapshot({ ...shared, partnership: [{ id: "p1", person_a_id: "a", person_b_id: "b" }] });
  const theirs = snapshot({
    ...shared,
    // The same couple under a different row id, and a new couple.
    partnership: [
      { id: "p9", person_a_id: "a", person_b_id: "b" },
      { id: "p2", person_a_id: "b", person_b_id: "c" },
    ],
  });

  assert.deepEqual(buildPlan(mine, theirs).inserts.partnership.map((row) => row.id), ["p2"]);
});

test("parents from the file are added while the child has room for them", () => {
  const people = { person: [person("child"), person("mum"), person("dad")] };
  const mine = snapshot({ ...people, parent_child: [parent("mum", "child")] });
  const theirs = snapshot({ ...people, parent_child: [parent("mum", "child"), parent("dad", "child")] });

  const plan = buildPlan(mine, theirs);

  assert.deepEqual(plan.inserts.parent_child, [parent("dad", "child")]);
  assert.deepEqual(plan.parentConflicts, []);
});

test("more than two parents in total is a conflict, not a link", () => {
  const people = { person: [person("child"), person("mum"), person("dad"), person("other")] };
  const mine = snapshot({ ...people, parent_child: [parent("mum", "child"), parent("dad", "child")] });
  const theirs = snapshot({ ...people, parent_child: [parent("mum", "child"), parent("other", "child")] });

  const plan = buildPlan(mine, theirs);

  assert.deepEqual(plan.inserts.parent_child, []);
  assert.equal(plan.parentConflicts.length, 1);
  const [conflict] = plan.parentConflicts;
  assert.equal(conflict.key, "parents:child");
  assert.equal(conflict.childId, "child");
  assert.deepEqual(conflict.theirParentIds, ["mum", "other"]);
  assert.deepEqual(conflict.differences, [{ label: "Parents", mine: "mum and dad", theirs: "mum and other" }]);
  assert.equal(isEmptyPlan(plan), false);
});

test("a parent link that would make someone their own ancestor is left out", () => {
  const people = { person: [person("gran"), person("mum"), person("child")] };
  const mine = snapshot({ ...people, parent_child: [parent("gran", "mum"), parent("mum", "child")] });
  // The file claims the child is the grandmother's parent.
  const theirs = snapshot({ ...people, parent_child: [parent("child", "gran")] });

  const plan = buildPlan(mine, theirs);

  assert.deepEqual(plan.inserts.parent_child, []);
  assert.equal(plan.skippedLinks, 1);
});

test("a loop made by two links from the file is caught at the second one", () => {
  const people = { person: [person("a"), person("b")] };
  const theirs = snapshot({ ...people, parent_child: [parent("a", "b"), parent("b", "a")] });

  const plan = buildPlan(snapshot(people), theirs);

  assert.equal(plan.inserts.parent_child.length, 1);
  assert.equal(plan.skippedLinks, 1);
});

test("people added with a name already in the tree are reported as possible duplicates", () => {
  const mine = snapshot({ person: [person("a", { given_name: "Ada", family_name: "Hill" }), person("x", { given_name: "" })] });
  const theirs = snapshot({
    person: [
      person("b", { given_name: "Ada", family_name: "Hill" }),
      person("c", { given_name: "Ben", family_name: "Hill" }),
      // Unnamed people are not worth reporting, even though the tree has one too.
      person("d", { given_name: "" }),
    ],
  });

  assert.deepEqual(buildPlan(mine, theirs).possibleDuplicates, ["Ada Hill"]);
});
