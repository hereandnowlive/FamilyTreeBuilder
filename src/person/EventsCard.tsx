import { useState } from "react";
import { PersonChip } from "../components/PersonChip";
import { Button, Card, inputClass } from "../components/ui";
import { updateEvent } from "../db";
import { displayName, lifespan, yearOf } from "../relations";
import type { EventFields, LifeEvent, Media, Person } from "../types";
import { PhotoGrid, type PhotoActions } from "./PhotoGrid";

interface Props {
  events: LifeEvent[];
  photos: Media[];
  /** The other people each event is shared with, by event id. */
  sharedWith: Map<string, Person[]>;
  /** Everyone who could be added to an event: all people except the one whose page this is. */
  candidates: Person[];
  photoActions: PhotoActions;
  /** Creates an event and resolves to its id. */
  onAdd: () => Promise<string | null>;
  onAddPhotos: (event: LifeEvent) => void;
  onAddPerson: (event: LifeEvent, personId: string) => void;
  onRemovePerson: (event: LifeEvent, person: Person) => void;
  /** Takes the event off this person's page but keeps it for the others. */
  onLeave: (event: LifeEvent) => void;
  /** Deletes the event for everyone. */
  onDelete: (event: LifeEvent, photoCount: number) => void;
  onOpenPerson: (personId: string) => void;
  /** Called after an event's text has been saved. */
  onChanged: () => void;
  onError: (message: string) => void;
}

/** Earliest year first; events with no year in their date go last, in the order they were added. */
function inDateOrder(events: LifeEvent[]): LifeEvent[] {
  const year = (event: LifeEvent) => yearOf(event.event_date) ?? Infinity;
  return [...events].sort((a, b) => year(a) - year(b));
}

export function EventsCard({ events, photos, sharedWith, onAdd, ...rest }: Props) {
  // The event just created, so its title can take focus.
  const [newId, setNewId] = useState<string | null>(null);

  return (
    <Card title="Major events" action={<Button onClick={async () => setNewId(await onAdd())}>+ Add event</Button>}>
      {events.length === 0 ? (
        <p className="text-muted">
          No events yet. Add the moments that shaped their life, such as a wedding, a move or a new job, each with
          its own photos.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {inDateOrder(events).map((event) => (
            <EventSection
              key={event.id}
              event={event}
              photos={photos.filter((photo) => photo.event_id === event.id)}
              others={sharedWith.get(event.id) ?? []}
              autoFocus={event.id === newId}
              {...rest}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

interface SectionProps extends Omit<Props, "events" | "sharedWith" | "onAdd"> {
  event: LifeEvent;
  others: Person[];
  autoFocus: boolean;
}

function EventSection({ event, photos, others, candidates, photoActions, autoFocus, ...on }: SectionProps) {
  const [draft, setDraft] = useState<EventFields>({
    title: event.title,
    event_date: event.event_date,
    description: event.description,
  });
  const [saved, setSaved] = useState(draft);

  async function save() {
    if (draft.title === saved.title && draft.event_date === saved.event_date && draft.description === saved.description)
      return;
    setSaved(draft);
    try {
      await updateEvent(event.id, draft);
      on.onChanged();
    } catch (e) {
      setSaved(saved);
      on.onError(String(e));
    }
  }

  const text = (key: keyof EventFields, placeholder: string) => ({
    value: draft[key],
    placeholder,
    "aria-label": placeholder,
    onChange: (e: { target: { value: string } }) => setDraft((current) => ({ ...current, [key]: e.target.value })),
    onBlur: save,
  });

  const addable = candidates.filter((person) => !others.some((other) => other.id === person.id));

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <div className="flex gap-3">
        <div className="flex-1">
          <input
            className={`${inputClass} font-serif text-base font-semibold`}
            autoFocus={autoFocus}
            {...text("title", "What happened? e.g. Wedding, Moved to Australia")}
          />
        </div>
        <div className="w-44 flex-none">
          <input className={inputClass} {...text("event_date", "When? e.g. Jun 1924")} />
        </div>
      </div>
      <textarea
        className={`${inputClass} resize-y font-serif text-[15px] leading-[1.6]`}
        rows={3}
        {...text("description", "What happened, who was there, why it mattered…")}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1.5 text-xs text-muted">{others.length > 0 ? "Shared with" : "Only on this page"}</span>
        {others.map((person) => (
          <PersonChip
            key={person.id}
            person={person}
            onOpen={() => on.onOpenPerson(person.id)}
            onRemove={() => on.onRemovePerson(event, person)}
            removeTitle="Take this event off their page"
          />
        ))}
        {addable.length > 0 && (
          <div className="w-52">
            {/* Always shows the prompt: picking a name adds that person and the list resets. */}
            <select
              className={inputClass}
              aria-label="Share this event with another person"
              value=""
              onChange={(e) => e.target.value && on.onAddPerson(event, e.target.value)}
            >
              <option value="">+ Share with a person…</option>
              {addable.map((person) => (
                <option key={person.id} value={person.id}>
                  {[displayName(person), lifespan(person)].filter(Boolean).join(", ")}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {photos.length > 0 && <PhotoGrid photos={photos} actions={photoActions} />}
      <div className="flex gap-2">
        <Button onClick={() => on.onAddPhotos(event)}>+ Add photos</Button>
        <div className="flex-1" />
        {others.length > 0 && (
          <Button variant="ghost" onClick={() => on.onLeave(event)}>
            Remove from this page
          </Button>
        )}
        <Button variant="ghost" className="text-danger" onClick={() => on.onDelete(event, photos.length)}>
          {others.length > 0 ? "Delete for everyone" : "Delete event"}
        </Button>
      </div>
    </article>
  );
}
