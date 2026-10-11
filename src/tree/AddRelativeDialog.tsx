import { useMemo, useState, type FormEvent } from "react";
import { Button, Field, inputClass, segmentClass as segment } from "../components/ui";
import { createPerson, linkRelative } from "../db";
import { candidatesFor, displayName, lifespan, type TreeIndex } from "../relations";
import { EMPTY_PERSON, type Person, type RelationKind, type Sex } from "../types";

interface Props {
  index: TreeIndex;
  /** The person the new relative attaches to; null adds an unconnected person. */
  anchor: Person | null;
  kind: RelationKind;
  onClose: () => void;
  onDone: (personId: string) => void;
}

export function AddRelativeDialog({ index, anchor, kind, onClose, onDone }: Props) {
  const candidates = useMemo(
    () => (anchor ? candidatesFor(index, anchor.id, kind) : []),
    [index, anchor, kind],
  );
  const partners = anchor
    ? (index.partnersOf.get(anchor.id) ?? []).map((id) => index.byId.get(id)!).filter(Boolean)
    : [];

  const [mode, setMode] = useState<"new" | "existing">("new");
  const [fields, setFields] = useState({
    ...EMPTY_PERSON,
    family_name: kind === "sibling" && anchor ? anchor.family_name : "",
  });
  const [existingId, setExistingId] = useState("");
  const [coParentId, setCoParentId] = useState(partners[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<typeof fields>) => setFields((current) => ({ ...current, ...patch }));
  const canSubmit = !busy && (mode === "new" || existingId !== "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const personId = mode === "new" ? await createPerson(fields) : existingId;
      if (anchor) {
        await linkRelative(anchor.id, kind, personId, kind === "child" ? coParentId : undefined);
      }
      onDone(personId);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-100 grid place-items-center bg-ink/45"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        className="flex w-[460px] max-w-[calc(100vw-2rem)] flex-col gap-3.5 rounded-xl bg-surface p-5.5 shadow-2xl"
        onSubmit={submit}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h2 className="font-serif text-[19px] font-semibold">
          {anchor ? `Add ${kind} of ${displayName(anchor)}` : "New person"}
        </h2>

        {anchor && candidates.length > 0 && (
          <div className="flex">
            <button type="button" className={segment(mode === "new")} onClick={() => setMode("new")}>
              New person
            </button>
            <button type="button" className={segment(mode === "existing")} onClick={() => setMode("existing")}>
              Already in the tree
            </button>
          </div>
        )}

        {mode === "new" ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Given names">
                <input
                  className={inputClass}
                  autoFocus
                  value={fields.given_name}
                  onChange={(e) => set({ given_name: e.target.value })}
                />
              </Field>
              <Field label="Family name">
                <input
                  className={inputClass}
                  value={fields.family_name}
                  onChange={(e) => set({ family_name: e.target.value })}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Sex">
                <select className={inputClass} value={fields.sex} onChange={(e) => set({ sex: e.target.value as Sex })}>
                  <option value="unknown">Not recorded</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                </select>
              </Field>
              <Field label="Born">
                <input
                  className={inputClass}
                  placeholder="e.g. 12 Mar 1902, abt. 1850"
                  value={fields.birth_date}
                  onChange={(e) => set({ birth_date: e.target.value })}
                />
              </Field>
            </div>
          </>
        ) : (
          <Field label="Person">
            <select
              className={inputClass}
              autoFocus
              value={existingId}
              onChange={(e) => setExistingId(e.target.value)}
            >
              <option value="">Choose…</option>
              {candidates.map((person) => (
                <option key={person.id} value={person.id}>
                  {[displayName(person), lifespan(person)].filter(Boolean).join(", ")}
                </option>
              ))}
            </select>
          </Field>
        )}

        {kind === "child" && partners.length > 0 && (
          <Field label="Other parent">
            <select className={inputClass} value={coParentId} onChange={(e) => setCoParentId(e.target.value)}>
              {partners.map((partner) => (
                <option key={partner.id} value={partner.id}>
                  {displayName(partner)}
                </option>
              ))}
              <option value="">Not recorded</option>
            </select>
          </Field>
        )}

        {error && <p className="text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            Add
          </Button>
        </div>
      </form>
    </div>
  );
}
