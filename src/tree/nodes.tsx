import { createContext, useContext } from "react";
import { Handle, NodeToolbar, Position, type NodeProps } from "@xyflow/react";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/ui";
import { MAX_PARENTS, displayName, lifespan, type TreeIndex } from "../relations";
import type { RelationKind, Sex } from "../types";
import { PERSON_HEIGHT, PERSON_WIDTH, UNION_SIZE, type PersonNodeType } from "./layout";

const SEX_ACCENT: Record<Sex, string> = {
  female: "border-l-female",
  male: "border-l-male",
  unknown: "",
};

/** What the tree view shares with its nodes, so node data stays just the person. */
export interface TreeUi {
  index: TreeIndex;
  selectedId: string | null;
  onAdd: (anchorId: string, kind: RelationKind) => void;
  onOpen: (personId: string) => void;
}

export const TreeUiContext = createContext<TreeUi | null>(null);

export function PersonNode({ id, data }: NodeProps<PersonNodeType>) {
  const ui = useContext(TreeUiContext)!;
  const { person } = data;
  const selected = ui.selectedId === id;
  const parentCount = (ui.index.parentsOf.get(id) ?? []).length;

  return (
    <>
      <NodeToolbar
        isVisible={selected}
        position={Position.Top}
        offset={8}
        className="flex gap-1 rounded-lg border border-line bg-surface p-1 whitespace-nowrap shadow-lg"
      >
        <Button size="sm" disabled={parentCount >= MAX_PARENTS} onClick={() => ui.onAdd(id, "parent")}>
          + Parent
        </Button>
        <Button size="sm" onClick={() => ui.onAdd(id, "partner")}>
          + Partner
        </Button>
        <Button size="sm" disabled={parentCount === 0} onClick={() => ui.onAdd(id, "sibling")}>
          + Sibling
        </Button>
        <Button size="sm" onClick={() => ui.onAdd(id, "child")}>
          + Child
        </Button>
        <Button size="sm" variant="primary" onClick={() => ui.onOpen(id)}>
          Open
        </Button>
      </NodeToolbar>
      <div
        className={`flex cursor-pointer items-center gap-2.5 rounded-lg border border-l-4 border-line bg-surface px-3 shadow-xs hover:shadow-md ${SEX_ACCENT[person.sex]} ${selected ? "outline-2 outline-offset-2 outline-accent" : ""}`}
        style={{ width: PERSON_WIDTH, height: PERSON_HEIGHT }}
      >
        <Handle id="top" type="target" position={Position.Top} isConnectable={false} />
        <Avatar person={person} size={40} />
        <div className="min-w-0">
          <div className="truncate font-serif text-[15px] font-semibold">{displayName(person)}</div>
          <div className="text-xs text-muted">{lifespan(person)}</div>
        </div>
        <Handle id="bottom" type="source" position={Position.Bottom} isConnectable={false} />
        <Handle id="left" type="source" position={Position.Left} isConnectable={false} />
        <Handle id="right" type="source" position={Position.Right} isConnectable={false} />
      </div>
    </>
  );
}

export function UnionNode() {
  return (
    <div className="rounded-full bg-edge" style={{ width: UNION_SIZE, height: UNION_SIZE }}>
      <Handle id="left" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="right" type="target" position={Position.Right} isConnectable={false} />
      <Handle id="bottom" type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}
