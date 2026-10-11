import { useCallback, useEffect, useState } from "react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { Button, Card, inputClass } from "../components/ui";
import { deleteDocument, importDocument, listDocuments, openDocument, updateDocumentTitle } from "../db";
import { saveCopyWithDialog } from "../familyFile";
import { DOCUMENT_FILTER } from "../fileFilters";
import type { PersonDocument } from "../types";

interface Props {
  personId: string;
  onError: (message: string) => void;
}

/** "will.PDF" -> "PDF": the kind of file, for the small label beside each document. */
function kindOf(fileName: string): string {
  return (fileName.split(".").pop() ?? "").toUpperCase();
}

/** The files attached to a person, such as PDFs and Word documents, with buttons to add, open and remove them. */
export function DocumentsCard({ personId, onError }: Props) {
  const [documents, setDocuments] = useState<PersonDocument[]>([]);
  const [adding, setAdding] = useState(false);
  const fail = useCallback((e: unknown) => onError(String(e)), [onError]);

  const refresh = useCallback(() => listDocuments(personId).then(setDocuments, fail), [personId, fail]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function add() {
    const picked = await open({ title: "Add documents", multiple: true, filters: [DOCUMENT_FILTER] });
    if (!picked) return;
    setAdding(true);
    try {
      for (const path of picked) await importDocument(personId, path);
    } catch (e) {
      fail(e);
    }
    setAdding(false);
    await refresh();
  }

  async function remove(document: PersonDocument) {
    const name = document.title.trim() || "this document";
    if (!(await confirm(`Remove ${name}? The copy stored in the app will be deleted.`, { kind: "warning" }))) return;
    await deleteDocument(document).catch(fail);
    await refresh();
  }

  return (
    <Card
      title="Documents"
      action={
        <Button disabled={adding} onClick={add}>
          {adding ? "Adding…" : "+ Add documents"}
        </Button>
      }
    >
      {documents.length === 0 ? (
        <p className="text-muted">
          No documents yet. Add files that belong with this person, such as a birth certificate saved as a PDF or a
          letter typed up in Word.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {documents.map((document) => (
            <li className="flex items-center gap-2" key={document.id}>
              <span className="w-12 flex-none rounded-sm border border-line bg-paper py-0.5 text-center text-xs text-muted">
                {kindOf(document.file_name)}
              </span>
              <input
                className={inputClass}
                placeholder="Name this document…"
                aria-label="Document name"
                defaultValue={document.title}
                onBlur={(e) => updateDocumentTitle(document.id, e.target.value).catch(fail)}
              />
              <Button className="flex-none" onClick={() => openDocument(document).catch(fail)}>
                Open
              </Button>
              <Button
                variant="ghost"
                className="flex-none"
                onClick={() => saveCopyWithDialog(document.file_name, document.title || "Document").catch(fail)}
              >
                Save a copy…
              </Button>
              <Button variant="ghost" className="flex-none text-danger" onClick={() => remove(document)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
