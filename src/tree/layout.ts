import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import { yearOf, type TreeIndex } from "../relations";
import type { Person, TreeData } from "../types";

export const PERSON_WIDTH = 210;
export const PERSON_HEIGHT = 64;
/** Horizontal space between partners; the couple's union dot sits in it. */
const PARTNER_GAP = 30;
export const UNION_SIZE = 10;

export type PersonNodeType = Node<{ person: Person }, "person">;
export type UnionNodeType = Node<Record<string, never>, "union">;
export type TreeNode = PersonNodeType | UnionNodeType;

/** Partners (and co-parents) laid out side by side as one unit. */
interface Block {
  id: string;
  members: string[];
}

const pairKey = (a: string, b: string) => (a < b ? `${a}+${b}` : `${b}+${a}`);

/**
 * Positions every person from scratch. Nothing about the layout is stored:
 * it is recomputed whenever the data changes, which is what makes the tree
 * re-space itself when someone is added.
 *
 * dagre does the heavy lifting, but it only understands a plain layered
 * graph, so it is given "blocks" rather than people: each block is a set of
 * partners that must sit next to each other on the same row. Parent -> child
 * links between blocks give one row per generation. People are then placed
 * inside their block, and each couple gets a small "union" dot between them
 * that their children's lines hang from.
 */
export function layoutTree(data: TreeData, index: TreeIndex): { nodes: TreeNode[]; edges: Edge[] } {
  // Oldest first, so siblings tend to come out in birth order.
  const people = [...data.people].sort(
    (a, b) => (yearOf(a.birth_date) ?? Infinity) - (yearOf(b.birth_date) ?? Infinity),
  );
  const parentsOf = (id: string) =>
    (index.parentsOf.get(id) ?? []).filter((parent) => index.byId.has(parent)).slice(0, 2);

  // ---- couples: recorded partnerships plus any two people who share a child
  const couples = new Map<string, [string, string]>();
  const partnersOf = new Map<string, string[]>();
  const addCouple = (a: string, b: string) => {
    const key = pairKey(a, b);
    if (a === b || couples.has(key) || !index.byId.has(a) || !index.byId.has(b)) return;
    couples.set(key, [a, b]);
    partnersOf.set(a, [...(partnersOf.get(a) ?? []), b]);
    partnersOf.set(b, [...(partnersOf.get(b) ?? []), a]);
  };
  for (const { person_a_id, person_b_id } of data.partnerships) addCouple(person_a_id, person_b_id);
  for (const person of people) {
    const parents = parentsOf(person.id);
    if (parents.length === 2) addCouple(parents[0], parents[1]);
  }

  // ---- blocks: everyone connected through couples shares a row
  const blockOf = new Map<string, Block>();
  const blocks: Block[] = [];
  for (const person of people) {
    if (blockOf.has(person.id)) continue;
    const group = new Set([person.id]);
    for (const id of group) for (const partner of partnersOf.get(id) ?? []) group.add(partner);

    // Walk outwards from whoever has the fewest partners, so someone with two
    // partners ends up between them instead of at one end.
    const degree = (id: string) => (partnersOf.get(id) ?? []).length;
    const start = [...group].reduce((best, id) => (degree(id) < degree(best) ? id : best));
    const members: string[] = [];
    const visit = (id: string) => {
      if (members.includes(id)) return;
      members.push(id);
      (partnersOf.get(id) ?? []).forEach(visit);
    };
    visit(start);

    const block = { id: `block:${start}`, members };
    blocks.push(block);
    for (const id of members) blockOf.set(id, block);
  }

  // ---- dagre lays out the blocks, one generation per rank
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 70 });
  graph.setDefaultEdgeLabel(() => ({}));
  const widthOf = (block: Block) =>
    block.members.length * PERSON_WIDTH + (block.members.length - 1) * PARTNER_GAP;
  for (const block of blocks) {
    graph.setNode(block.id, { width: widthOf(block), height: PERSON_HEIGHT });
  }
  for (const person of people) {
    const childBlock = blockOf.get(person.id)!;
    for (const parent of parentsOf(person.id)) {
      const parentBlock = blockOf.get(parent)!;
      if (parentBlock !== childBlock) graph.setEdge(parentBlock.id, childBlock.id);
    }
  }
  dagre.layout(graph);

  // ---- place people inside their block
  // In a couple, each partner goes on the side nearest their own parents so
  // the lines down from the two sets of grandparents do not cross.
  const parentsX = (id: string): number | null => {
    const xs = parentsOf(id).map((parent) => graph.node(blockOf.get(parent)!.id).x);
    return xs.length > 0 ? xs.reduce((sum, x) => sum + x, 0) / xs.length : null;
  };
  const position = new Map<string, { x: number; y: number }>();
  for (const block of blocks) {
    const { x, y } = graph.node(block.id); // centre of the block
    const members = [...block.members];
    if (members.length === 2) {
      const [left, right] = members.map((id) => parentsX(id) ?? x);
      if (left > right) members.reverse();
    }
    const blockLeft = x - widthOf(block) / 2;
    members.forEach((id, i) => {
      position.set(id, {
        x: blockLeft + i * (PERSON_WIDTH + PARTNER_GAP),
        y: y - PERSON_HEIGHT / 2,
      });
    });
  }

  // ---- React Flow nodes and edges
  const nodes: TreeNode[] = people.map((person) => ({
    id: person.id,
    type: "person",
    data: { person },
    position: position.get(person.id)!,
    width: PERSON_WIDTH,
    height: PERSON_HEIGHT,
    draggable: false,
  }));
  const edges: Edge[] = [];

  for (const [key, couple] of couples) {
    const [left, right] = [...couple].sort((a, b) => position.get(a)!.x - position.get(b)!.x);
    const leftPos = position.get(left)!;
    const rightPos = position.get(right)!;
    const unionId = `union:${key}`;
    nodes.push({
      id: unionId,
      type: "union",
      data: {},
      position: {
        x: (leftPos.x + PERSON_WIDTH + rightPos.x) / 2 - UNION_SIZE / 2,
        y: leftPos.y + PERSON_HEIGHT / 2 - UNION_SIZE / 2,
      },
      width: UNION_SIZE,
      height: UNION_SIZE,
      draggable: false,
    });
    edges.push(
      { id: `${left}>${unionId}`, source: left, sourceHandle: "right", target: unionId, targetHandle: "left", type: "straight" },
      { id: `${right}>${unionId}`, source: right, sourceHandle: "left", target: unionId, targetHandle: "right", type: "straight" },
    );
  }

  for (const person of people) {
    const parents = parentsOf(person.id);
    if (parents.length === 0) continue;
    const source = parents.length === 2 ? `union:${pairKey(parents[0], parents[1])}` : parents[0];
    edges.push({
      id: `${source}>${person.id}`,
      source,
      sourceHandle: "bottom",
      target: person.id,
      targetHandle: "top",
      type: "smoothstep",
    });
  }

  return { nodes, edges };
}
