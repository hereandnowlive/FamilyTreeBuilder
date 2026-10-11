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

// The events that are expanded, by id. Kept outside the component so that coming back from a
// photo's page, which rebuilds the person page, finds the same events open as before.
const openEvents = new Set<string>();

export function EventsCard({ events, photos, sharedWith, onAdd, ...rest }: Props) {
  // The event just created, so its title can take focus.
  const [newId, setNewId] = useState<string | null>(null);
  // A copy of `openEvents` as state, because changing the set itself would not redraw anything.
  const [open, setOpen] = useState(() => new Set(openEvents));

  /** Expands or collapses the given events. */
  function setExpanded(ids: string[], expanded: boolean) {
    for (const id of ids) {
      if (expanded) openEvents.add(id);
      else openEvents.delete(id);
    }
    setOpen(new Set(openEvents));
  }

  async function add() {
    const id = await onAdd();
    // A new event starts expanded, ready to be filled in.
    if (id) setExpanded([id], true);
    setNewId(id);
  }

  const allIds = events.map((event) => event.id);
  const allOpen = allIds.every((id) => open.has(id));

  return (
    <Card
      title="Major events"
      action={
        <div className="flex gap-2">
          {events.length > 1 && (
            <Button variant="ghost" onClick={() => setExpanded(allIds, !allOpen)}>
              {allOpen ? "Collapse all" : "Expand all"}
            </Button>
          )}
          <Button onClick={add}>+ Add event</Button>
        </div>
      }
    >
      {events.length === 0 ? (
        <p className="text-muted">
          No events yet. Add the moments that shaped their life, such as a wedding, a move or a new job, each with
          its own photos.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {inDateOrder(events).map((event) => (
            <EventSection
              key={event.id}
              event={event}
              photos={photos.filter((photo) => photo.event_id === event.id)}
              others={sharedWith.get(event.id) ?? []}
              autoFocus={event.id === newId}
              expanded={open.has(event.id)}
              onToggle={() => setExpanded([event.id], !open.has(event.id))}
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
  expanded: boolean;
  onToggle: () => void;
}

/** "3 photos", "1 photo", or null for none. */
function countOf(n: number, one: string, many: string): string | null {
  return n === 0 ? null : `${n} ${n === 1 ? one : many}`;
}

/**
 * One event as an accordion section. Collapsed, it is a single row: title, date and a short summary.
 * Expanded, the row becomes the editable title and date, with everything else below it.
 */
function EventSection({
  event,
  photos,
  others,
  candidates,
  photoActions,
  autoFocus,
  expanded,
  onToggle,
  ...on
}: SectionProps) {
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

  // The arrow that expands and collapses the section. It turns to point down when expanded.
  const arrow = (
    <span className={`inline-block w-4 flex-none text-center text-muted transition-transform ${expanded ? "rotate-90" : ""}`}>
      ▸
    </span>
  );

  if (!expanded) {
    const shared = countOf(others.length, "other person", "other people");
    const summary = [countOf(photos.length, "photo", "photos"), shared && `shared with ${shared}`].filter(Boolean);
    return (
      <article className="rounded-lg border border-line">
        {/* The whole row is the button, so there is a large target to click. */}
        <button
          className="flex w-full cursor-pointer items-baseline gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-paper focus:outline-2 focus:outline-accent/45"
          aria-expanded={false}
          title="Show this event"
          onClick={onToggle}
        >
          {arrow}
          <span className={`min-w-0 flex-1 truncate font-serif text-base font-semibold ${draft.title.trim() ? "" : "text-muted"}`}>
            {draft.title.trim() || "Untitled event"}
          </span>
          {summary.length > 0 && <span className="flex-none text-xs text-muted">{summary.join(" · ")}</span>}
          {draft.event_date.trim() && <span className="w-32 flex-none text-right text-muted">{draft.event_date}</span>}
        </button>
      </article>
    );
  }

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-line p-4 pl-3">
      <div className="flex items-center gap-3">
        <button
          className="-my-1 flex-none cursor-pointer rounded-md py-1 text-base hover:bg-paper focus:outline-2 focus:outline-accent/45"
          aria-expanded={true}
          aria-label="Hide this event's details"
          title="Hide this event's details"
          onClick={onToggle}
        >
          {arrow}
        </button>
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
      {/* Lined up under the title, clear of the arrow. */}
      <div className="flex flex-col gap-3 pl-7">
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
      </div>
    </article>
  );
}
