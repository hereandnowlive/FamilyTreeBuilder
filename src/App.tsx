import { useCallback, useEffect, useMemo, useState } from "react";
import { initStorage, loadTree, pendingMerge } from "./db";
import { HelpPage } from "./help/HelpPage";
import { MergePage } from "./merge/MergePage";
import { PersonPage } from "./person/PersonPage";
import { PhotoPage } from "./person/PhotoPage";
import { indexTree } from "./relations";
import { TreeView } from "./tree/TreeView";
import type { TreeData } from "./types";

type View =
  | { name: "tree" }
  | { name: "help" }
  | { name: "person"; id: string }
  | { name: "photo"; personId: string; mediaId: string };

export default function App() {
  const [data, setData] = useState<TreeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: "tree" });
  const [lastOpenedId, setLastOpenedId] = useState<string | null>(null);
  // True while a family file is waiting to be merged; the merge screen then replaces everything else.
  const [merging, setMerging] = useState(false);

  const reload = useCallback(async () => setData(await loadTree()), []);
  const index = useMemo(() => (data ? indexTree(data) : null), [data]);

  useEffect(() => {
    initStorage()
      .then(async () => {
        if (await pendingMerge()) setMerging(true);
        else await reload();
      })
      .catch((e) => setError(String(e)));
  }, [reload]);

  const openPerson = useCallback((id: string) => {
    setLastOpenedId(id);
    setView({ name: "person", id });
  }, []);
  const openTree = useCallback(() => setView({ name: "tree" }), []);

  if (error) return <div className="p-8 text-danger">Could not open the family tree data: {error}</div>;
  if (merging) {
    return (
      <MergePage
        onDone={async () => {
          await reload();
          setMerging(false);
        }}
      />
    );
  }
  if (!data || !index) return null;

  if (view.name === "help") return <HelpPage onBack={openTree} />;

  const personId = view.name === "person" ? view.id : view.name === "photo" ? view.personId : null;
  const person = personId ? index.byId.get(personId) : undefined;
  if (person && view.name === "photo") {
    return (
      <PhotoPage
        key={view.mediaId}
        person={person}
        mediaId={view.mediaId}
        reload={reload}
        onBack={() => openPerson(person.id)}
      />
    );
  }
  if (person) {
    return (
      <PersonPage
        key={person.id}
        person={person}
        index={index}
        reload={reload}
        onBack={openTree}
        onNavigate={openPerson}
        onOpenPhoto={(mediaId) => setView({ name: "photo", personId: person.id, mediaId })}
      />
    );
  }
  return (
    <TreeView
      data={data}
      index={index}
      reload={reload}
      onOpen={openPerson}
      onHelp={() => setView({ name: "help" })}
      initialSelectedId={lastOpenedId && index.byId.has(lastOpenedId) ? lastOpenedId : null}
    />
  );
}
