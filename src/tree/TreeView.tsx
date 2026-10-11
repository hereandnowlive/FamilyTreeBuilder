import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { message } from "@tauri-apps/plugin-dialog";
import { Button, TopBar, inputClass } from "../components/ui";
import { mergeFamilyFileWithDialog, openFamilyFileWithDialog, saveFamilyFileWithDialog } from "../familyFile";
import { displayName, lifespan, type TreeIndex } from "../relations";
import type { RelationKind, TreeData } from "../types";
import { AddRelativeDialog } from "./AddRelativeDialog";
import { PERSON_HEIGHT, PERSON_WIDTH, layoutTree, type TreeNode } from "./layout";
import { PersonNode, TreeUiContext, UnionNode, type TreeUi } from "./nodes";

const nodeTypes = { person: PersonNode, union: UnionNode };

// Remembered across visits to a person's page so the tree reopens where it was left.
let savedViewport: Viewport | null = null;

interface Props {
  data: TreeData;
  index: TreeIndex;
  reload: () => Promise<void>;
  onOpen: (personId: string) => void;
  onHelp: () => void;
  /** Person to show selected when the view opens (the one just visited). */
  initialSelectedId: string | null;
}

export function TreeView(props: Props) {
  return (
    <ReactFlowProvider>
      <TreeCanvas {...props} />
    </ReactFlowProvider>
  );
}

function TreeCanvas({ data, index, reload, onOpen, onHelp, initialSelectedId }: Props) {
  const flow = useReactFlow();
  const layout = useMemo(() => layoutTree(data, index), [data, index]);
  const [nodes, setNodes, onNodesChange] = useNodesState<TreeNode>(layout.nodes);
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [adding, setAdding] = useState<{ anchorId: string | null; kind: RelationKind } | null>(null);
  const [query, setQuery] = useState("");
  const [fileBusy, setFileBusy] = useState<"open" | "merge" | "save" | null>(null);
  // A person to pan to once the next layout containing them has been applied.
  const pendingFocus = useRef<string | null>(null);

  const centerOn = useCallback(
    (node: TreeNode) =>
      flow.setCenter(node.position.x + PERSON_WIDTH / 2, node.position.y + PERSON_HEIGHT / 2, {
        zoom: Math.max(flow.getZoom(), 0.6),
        duration: 400,
      }),
    [flow],
  );

  useEffect(() => {
    setNodes(layout.nodes);
    const target = layout.nodes.find((node) => node.id === pendingFocus.current);
    if (target) {
      pendingFocus.current = null;
      centerOn(target);
    }
  }, [layout, setNodes, centerOn]);

  useEffect(
    () => () => {
      savedViewport = flow.getViewport();
    },
    [flow],
  );

  const ui = useMemo<TreeUi>(
    () => ({
      index,
      selectedId,
      onAdd: (anchorId, kind) => setAdding({ anchorId, kind }),
      onOpen,
    }),
    [index, selectedId, onOpen],
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return data.people.filter((p) => displayName(p).toLowerCase().includes(needle)).slice(0, 8);
  }, [query, data.people]);

  function jumpTo(personId: string) {
    setQuery("");
    setSelectedId(personId);
    const node = layout.nodes.find((n) => n.id === personId);
    if (node) centerOn(node);
  }

  async function runFileAction(kind: "open" | "merge" | "save") {
    setFileBusy(kind);
    try {
      if (kind === "save") await saveFamilyFileWithDialog();
      else if (kind === "merge") await mergeFamilyFileWithDialog();
      else await openFamilyFileWithDialog(data.people.length > 0);
    } catch (e) {
      await message(String(e), { title: "Family file", kind: "error" });
    } finally {
      setFileBusy(null);
    }
  }

  async function handleAdded(personId: string) {
    setAdding(null);
    setSelectedId(personId);
    pendingFocus.current = personId;
    await reload();
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <h1 className="font-serif text-xl font-semibold">Family Tree Builder</h1>
        <span className="text-muted">
          {data.people.length} {data.people.length === 1 ? "person" : "people"}
        </span>
        <div className="flex-1" />
        <div className="relative w-60">
          <input
            className={inputClass}
            type="search"
            placeholder="Find a person…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && matches[0] && jumpTo(matches[0].id)}
          />
          {matches.length > 0 && (
            <ul className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border border-line bg-surface p-1 shadow-lg">
              {matches.map((person) => (
                <li key={person.id}>
                  <button
                    className="w-full cursor-pointer rounded-md px-3 py-1.5 text-left hover:bg-paper"
                    onClick={() => jumpTo(person.id)}
                  >
                    {displayName(person)} <span className="text-muted">{lifespan(person)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button onClick={() => setAdding({ anchorId: null, kind: "partner" })}>+ New person</Button>
        <Button disabled={fileBusy !== null} onClick={() => runFileAction("open")}>
          {fileBusy === "open" ? "Opening…" : "Open file…"}
        </Button>
        <Button disabled={fileBusy !== null || data.people.length === 0} onClick={() => runFileAction("merge")}>
          {fileBusy === "merge" ? "Preparing…" : "Merge file…"}
        </Button>
        <Button disabled={fileBusy !== null || data.people.length === 0} onClick={() => runFileAction("save")}>
          {fileBusy === "save" ? "Saving…" : "Save file…"}
        </Button>
        <Button onClick={onHelp}>Help</Button>
      </TopBar>

      <div className="relative min-h-0 flex-1">
        <TreeUiContext.Provider value={ui}>
          <ReactFlow
            nodes={nodes}
            edges={layout.edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_, node) => node.type === "person" && setSelectedId(node.id)}
            onNodeDoubleClick={(_, node) => node.type === "person" && onOpen(node.id)}
            onPaneClick={() => setSelectedId(null)}
            defaultViewport={savedViewport ?? undefined}
            fitView={!savedViewport}
            fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
            minZoom={0.05}
            maxZoom={2}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            edgesFocusable={false}
            zoomOnDoubleClick={false}
            onlyRenderVisibleElements
          >
            <Background gap={24} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </TreeUiContext.Provider>

        {data.people.length === 0 && (
          <div className="absolute top-1/2 left-1/2 w-[360px] -translate-1/2 rounded-xl border border-line bg-surface p-7 text-center">
            <h2 className="font-serif text-xl font-semibold">Start your family tree</h2>
            <p className="my-3.5">
              Add the first person, then grow the tree from them by adding parents, partners and children.
            </p>
            <div className="flex flex-col items-center gap-2">
              <Button variant="primary" onClick={() => setAdding({ anchorId: null, kind: "partner" })}>
                Add the first person
              </Button>
              <Button disabled={fileBusy !== null} onClick={() => runFileAction("open")}>
                Open a family file you were sent
              </Button>
              <Button variant="ghost" onClick={onHelp}>
                How to use this app
              </Button>
            </div>
          </div>
        )}
        {data.people.length > 0 && !selectedId && (
          <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-surface/85 px-3 py-1 text-xs text-muted">
            Click a person to add relatives · double-click to open their page
          </div>
        )}
      </div>

      {adding && (
        <AddRelativeDialog
          index={index}
          anchor={adding.anchorId ? (index.byId.get(adding.anchorId) ?? null) : null}
          kind={adding.kind}
          onClose={() => setAdding(null)}
          onDone={handleAdded}
        />
      )}
    </div>
  );
}
