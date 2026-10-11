// Works out what merging a family file into the current tree would do, without touching either.
//
// Both trees descend from the same family file, and every record has a random unique id, so a
// record with the same id in both is the same person, event, photo or recording.
//
// - Only in the file: it is added.
// - Only in the current tree: it is kept. A merge never deletes, because there is no way to tell
//   "they deleted it" from "I added it".
// - In both: compared field by field. Where one side is blank the other side's value is used.
//   Where both have a value and they differ, that is a conflict for the user to settle.

/** A database row exactly as `SELECT *` returns it. */
export type Row = Record<string, string | number | null>;

/** Every row of every table, by table name. */
export interface Snapshot {
  person: Row[];
  event: Row[];
  event_participant: Row[];
  media: Row[];
  audio: Row[];
  partnership: Row[];
  parent_child: Row[];
}

/** Tables in an order that satisfies their foreign keys when rows are inserted. */
export const INSERT_ORDER = [
  "person",
  "event",
  "event_participant",
  "media",
  "audio",
  "partnership",
  "parent_child",
] as const satisfies readonly (keyof Snapshot)[];

type RecordTable = "person" | "event" | "media" | "audio";

interface Field {
  column: string;
  label: string;
  /** A value that means "not filled in", besides blank. */
  blank?: string;
}

/** The columns a user can edit, which are the only ones that can conflict. */
const FIELDS: Record<RecordTable, Field[]> = {
  person: [
    { column: "given_name", label: "Given names" },
    { column: "family_name", label: "Family name" },
    { column: "sex", label: "Sex", blank: "unknown" },
    { column: "birth_date", label: "Born" },
    { column: "birth_place", label: "Birthplace" },
    { column: "death_date", label: "Died" },
    { column: "death_place", label: "Place of death" },
    { column: "biography", label: "Their story" },
    { column: "portrait_media_id", label: "Portrait" },
  ],
  event: [
    { column: "title", label: "What happened" },
    { column: "event_date", label: "When" },
    { column: "description", label: "Explanation" },
  ],
  media: [
    { column: "caption", label: "Caption" },
    { column: "description", label: "Description" },
  ],
  audio: [{ column: "title", label: "Recording name" }],
};

export type Choice = "mine" | "theirs";

/** One row of the side-by-side comparison shown for a conflict. */
export interface Difference {
  label: string;
  mine: string;
  theirs: string;
}

/** A disagreement the user has to settle by choosing one side. */
interface ConflictBase {
  /** Unique within a plan; the key the user's choice is stored under. */
  key: string;
  /** What sort of thing it is, e.g. "Person". */
  kind: string;
  title: string;
  differences: Difference[];
}

/** The same record was changed differently on each side. */
export interface RecordConflict extends ConflictBase {
  table: RecordTable;
  id: string;
  /** The columns to overwrite, with the file's values, if the user chooses "theirs". */
  theirs: Row;
}

/** Combining both sides' parents would give someone more than two. */
export interface ParentConflict extends ConflictBase {
  childId: string;
  /** The parent ids to end up with if the user chooses "theirs". */
  theirParentIds: string[];
}

export interface Update {
  table: RecordTable;
  id: string;
  set: Row;
}

export interface MergePlan {
  /** Rows that exist only in the file. */
  inserts: Snapshot;
  /** Blank fields in the current tree that the file has a value for. */
  fills: Update[];
  conflicts: RecordConflict[];
  parentConflicts: ParentConflict[];
  /** Photo and recording files to copy in for the inserted rows. */
  files: string[];
  /** Names of people being added who share a name with someone already in the tree. */
  possibleDuplicates: string[];
  /** Parent links left out because they would make someone their own ancestor. */
  skippedLinks: number;
}

const text = (value: Row[string] | undefined) => (value == null ? "" : String(value));
const isBlank = (value: Row[string], field: Field) => text(value).trim() === "" || value === field.blank;
const byId = (rows: Row[]) => new Map(rows.map((row) => [text(row.id), row]));

function personName(row: Row | undefined): string {
  return row ? `${text(row.given_name)} ${text(row.family_name)}`.trim() || "Unnamed" : "Unknown person";
}

/** How a field's value is shown to the user in a comparison. */
function shown(field: Field, value: Row[string], side: Choice): string {
  if (field.column === "portrait_media_id") return side === "mine" ? "The photo chosen in your tree" : "The photo chosen in the file";
  if (field.column === "sex") return text(value).charAt(0).toUpperCase() + text(value).slice(1);
  return text(value);
}

export function buildPlan(mine: Snapshot, theirs: Snapshot): MergePlan {
  const plan: MergePlan = {
    inserts: { person: [], event: [], event_participant: [], media: [], audio: [], partnership: [], parent_child: [] },
    fills: [],
    conflicts: [],
    parentConflicts: [],
    files: [],
    possibleDuplicates: [],
    skippedLinks: 0,
  };

  // Lookups across both trees, for naming things in conflict titles.
  const people = new Map([...byId(theirs.person), ...byId(mine.person)]);
  const events = new Map([...byId(theirs.event), ...byId(mine.event)]);
  const media = new Map([...byId(theirs.media), ...byId(mine.media)]);
  const eventTitle = (id: Row[string]) => text(events.get(text(id))?.title).trim() || "Untitled event";

  const describe: Record<RecordTable, (row: Row) => { kind: string; title: string }> = {
    person: (row) => ({ kind: "Person", title: personName(row) }),
    event: (row) => ({ kind: "Event", title: eventTitle(row.id) }),
    media: (row) => ({
      kind: "Photo",
      title: `${text(row.caption).trim() || "Untitled photo"}, in "${eventTitle(row.event_id)}"`,
    }),
    audio: (row) => {
      const photo = media.get(text(row.media_id));
      return {
        kind: "Recording",
        title: `${text(row.title).trim() || "Untitled recording"}, on a photo in "${eventTitle(photo?.event_id ?? null)}"`,
      };
    },
  };

  // ---- records: people, events, photos, recordings ----
  for (const table of ["person", "event", "media", "audio"] as const) {
    const existing = byId(mine[table]);
    for (const their of theirs[table]) {
      const id = text(their.id);
      const own = existing.get(id);
      if (!own) {
        plan.inserts[table].push(their);
        if (table === "media" || table === "audio") plan.files.push(text(their.file_name));
        continue;
      }

      const fill: Row = {};
      const override: Row = {};
      const differences: Difference[] = [];
      for (const field of FIELDS[table]) {
        const [a, b] = [own[field.column], their[field.column]];
        if (text(a) === text(b) || isBlank(b, field)) continue;
        if (isBlank(a, field)) {
          fill[field.column] = b;
        } else {
          override[field.column] = b;
          differences.push({ label: field.label, mine: shown(field, a, "mine"), theirs: shown(field, b, "theirs") });
        }
      }
      if (Object.keys(fill).length > 0) plan.fills.push({ table, id, set: fill });
      if (differences.length > 0) {
        plan.conflicts.push({ key: `${table}:${id}`, table, id, ...describe[table](own), differences, theirs: override });
      }
    }
  }

  const existingNames = new Set(mine.person.map(personName));
  plan.possibleDuplicates = plan.inserts.person
    .map(personName)
    .filter((name) => name !== "Unnamed" && existingNames.has(name));

  // ---- links that simply combine ----
  const linkKey = (row: Row, a: string, b: string) => `${text(row[a])}|${text(row[b])}`;
  const combine = (table: "event_participant" | "partnership", a: string, b: string) => {
    const existing = new Set(mine[table].map((row) => linkKey(row, a, b)));
    plan.inserts[table] = theirs[table].filter((row) => !existing.has(linkKey(row, a, b)));
  };
  combine("event_participant", "event_id", "person_id");
  combine("partnership", "person_a_id", "person_b_id");

  // ---- parents: at most two each, and nobody may become their own ancestor ----
  const parentsOf = new Map<string, Set<string>>();
  for (const row of mine.parent_child) {
    const child = text(row.child_id);
    parentsOf.set(child, (parentsOf.get(child) ?? new Set()).add(text(row.parent_id)));
  }
  const theirParentsOf = new Map<string, string[]>();
  for (const row of theirs.parent_child) {
    const child = text(row.child_id);
    theirParentsOf.set(child, [...(theirParentsOf.get(child) ?? []), text(row.parent_id)]);
  }
  const isAncestor = (ancestor: string, of: string): boolean => {
    const seen = new Set<string>();
    const queue = [of];
    while (queue.length > 0) {
      for (const parent of parentsOf.get(queue.pop()!) ?? []) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return false;
  };

  for (const [child, theirParents] of theirParentsOf) {
    const own = parentsOf.get(child) ?? new Set<string>();
    const added = theirParents.filter((parent) => !own.has(parent));
    if (added.length === 0) continue;

    if (own.size + added.length > 2) {
      const names = (ids: Iterable<string>) => [...ids].map((id) => personName(people.get(id))).join(" and ");
      plan.parentConflicts.push({
        key: `parents:${child}`,
        kind: "Parents",
        title: `Parents of ${personName(people.get(child))}`,
        differences: [{ label: "Parents", mine: names(own), theirs: names(theirParents) }],
        childId: child,
        theirParentIds: theirParents,
      });
      continue;
    }
    for (const parent of added) {
      if (parent === child || isAncestor(child, parent)) {
        plan.skippedLinks++;
        continue;
      }
      plan.inserts.parent_child.push({ parent_id: parent, child_id: child });
      parentsOf.set(child, (parentsOf.get(child) ?? new Set()).add(parent));
    }
  }

  return plan;
}

/** True when the merge would change nothing at all. */
export function isEmptyPlan(plan: MergePlan): boolean {
  return (
    INSERT_ORDER.every((table) => plan.inserts[table].length === 0) &&
    plan.fills.length === 0 &&
    plan.conflicts.length === 0 &&
    plan.parentConflicts.length === 0
  );
}
