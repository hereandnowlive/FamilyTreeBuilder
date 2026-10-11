import type { Person, RelationKind, TreeData } from "./types";

export const MAX_PARENTS = 2;

/** Lookup tables built once per data load so relationship queries are cheap. */
export interface TreeIndex {
  byId: Map<string, Person>;
  parentsOf: Map<string, string[]>;
  childrenOf: Map<string, string[]>;
  partnersOf: Map<string, string[]>;
}

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function indexTree(data: TreeData): TreeIndex {
  const index: TreeIndex = {
    byId: new Map(data.people.map((p) => [p.id, p])),
    parentsOf: new Map(),
    childrenOf: new Map(),
    partnersOf: new Map(),
  };
  for (const { parent_id, child_id } of data.parentLinks) {
    push(index.parentsOf, child_id, parent_id);
    push(index.childrenOf, parent_id, child_id);
  }
  for (const { person_a_id, person_b_id } of data.partnerships) {
    push(index.partnersOf, person_a_id, person_b_id);
    push(index.partnersOf, person_b_id, person_a_id);
  }
  return index;
}

function reachable(links: Map<string, string[]>, start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    for (const next of links.get(queue.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

export const ancestorsOf = (index: TreeIndex, id: string) => reachable(index.parentsOf, id);
export const descendantsOf = (index: TreeIndex, id: string) => reachable(index.childrenOf, id);

export function siblingsOf(index: TreeIndex, id: string): string[] {
  const siblings = new Set<string>();
  for (const parent of index.parentsOf.get(id) ?? []) {
    for (const child of index.childrenOf.get(parent) ?? []) {
      if (child !== id) siblings.add(child);
    }
  }
  return [...siblings];
}

/**
 * People already in the tree who could be linked to `anchorId` as `kind`
 * without creating a loop (e.g. someone becoming their own ancestor) or
 * giving anyone more than two parents.
 */
export function candidatesFor(index: TreeIndex, anchorId: string, kind: RelationKind): Person[] {
  const partners = new Set(index.partnersOf.get(anchorId) ?? []);
  const parents = new Set(index.parentsOf.get(anchorId) ?? []);
  const hasNoParents = (id: string) => (index.parentsOf.get(id) ?? []).length === 0;

  let allowed: (id: string) => boolean;
  switch (kind) {
    case "partner":
      allowed = (id) => !partners.has(id);
      break;
    case "parent": {
      const descendants = descendantsOf(index, anchorId);
      allowed = (id) => !parents.has(id) && !descendants.has(id);
      break;
    }
    case "child":
    case "sibling": {
      const ancestors = ancestorsOf(index, anchorId);
      allowed = (id) => hasNoParents(id) && !ancestors.has(id) && !partners.has(id);
      break;
    }
  }
  return [...index.byId.values()]
    .filter((p) => p.id !== anchorId && allowed(p.id))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
}

export function displayName(person: Person): string {
  return `${person.given_name} ${person.family_name}`.trim() || "Unnamed";
}

export function initials(person: Person): string {
  const letters = (person.given_name.trim()[0] ?? "") + (person.family_name.trim()[0] ?? "");
  return letters.toUpperCase() || "?";
}

/** First four-digit year found in a free-text date, e.g. "abt. Mar 1850" -> 1850. */
export function yearOf(date: string): number | null {
  const match = /\b(\d{4})\b/.exec(date);
  return match ? Number(match[1]) : null;
}

export function lifespan(person: Person): string {
  const born = yearOf(person.birth_date);
  const died = yearOf(person.death_date);
  if (born && died) return `${born} – ${died}`;
  if (born) return `b. ${born}`;
  if (died) return `d. ${died}`;
  return "";
}
