import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { Avatar } from "../components/Avatar";
import { PersonChip } from "../components/PersonChip";
import { Button, Card, Field, TopBar, inputClass } from "../components/ui";
import {
  addEventPerson,
  createEvent,
  deleteEvent,
  deleteMedia,
  deletePerson,
  importPhoto,
  listEventLinks,
  listEvents,
  listMedia,
  removeEventPerson,
  removeParentLink,
  removePartnership,
  setPortrait,
  updateCaption,
  updatePerson,
} from "../db";
import { IMAGE_FILTER } from "../fileFilters";
import { displayName, lifespan, siblingsOf, type TreeIndex } from "../relations";
import type { EventLink, LifeEvent, Media, Person, PersonFields, Sex } from "../types";
import { EventsCard } from "./EventsCard";

// How far down the page, in pixels, before the "Back to top" button appears.
const BACK_TO_TOP_AFTER = 600;

// Where the page was scrolled to when a photo was opened, so coming back lands on the same spot.
let savedScroll: { personId: string; top: number } | null = null;

interface Props {
  person: Person;
  index: TreeIndex;
  reload: () => Promise<void>;
  onBack: () => void;
  onNavigate: (personId: string) => void;
  onOpenPhoto: (mediaId: string) => void;
}

function fieldsOf(person: Person): PersonFields {
  const { given_name, family_name, sex, birth_date, birth_place, death_date, death_place, biography } = person;
  return { given_name, family_name, sex, birth_date, birth_place, death_date, death_place, biography };
}

export function PersonPage({ person, index, reload, onBack, onNavigate, onOpenPhoto }: Props) {
  const [draft, setDraft] = useState(() => fieldsOf(person));
  const [events, setEvents] = useState<LifeEvent[]>([]);
  const [eventLinks, setEventLinks] = useState<EventLink[]>([]);
  const [photos, setPhotos] = useState<Media[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Refs so save() always sees the latest values, including from the unmount cleanup.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savedRef = useRef(fieldsOf(person));

  const save = useCallback(async () => {
    const current = draftRef.current;
    const saved = savedRef.current;
    const dirty = (Object.keys(current) as (keyof PersonFields)[]).some((key) => current[key] !== saved[key]);
    if (!dirty) return;
    savedRef.current = current;
    try {
      await updatePerson(person.id, current);
      await reload();
    } catch (e) {
      savedRef.current = saved;
      setError(String(e));
    }
  }, [person.id, reload]);

  const refreshPhotos = useCallback(
    () => listMedia(person.id).then(setPhotos, (e) => setError(String(e))),
    [person.id],
  );
  const refreshEvents = useCallback(
    () =>
      Promise.all([listEvents(person.id), listEventLinks(person.id)]).then(
        ([loadedEvents, loadedLinks]) => {
          setEvents(loadedEvents);
          setEventLinks(loadedLinks);
        },
        (e) => setError(String(e)),
      ),
    [person.id],
  );
  const scroller = useRef<HTMLElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [scrolledFar, setScrolledFar] = useState(false);
  useEffect(() => {
    Promise.all([refreshEvents(), refreshPhotos()]).then(() => setLoaded(true));
  }, [refreshEvents, refreshPhotos]);

  // Restored only once the events and photos are on the page, because until then it is too short to scroll.
  useLayoutEffect(() => {
    if (!loaded || !scroller.current) return;
    if (savedScroll?.personId === person.id) scroller.current.scrollTop = savedScroll.top;
    savedScroll = null;
  }, [loaded, person.id]);

  function openPhoto(photo: Media) {
    savedScroll = { personId: person.id, top: scroller.current?.scrollTop ?? 0 };
    leave(() => onOpenPhoto(photo.id));
  }

  // The other people each event is shared with, by event id.
  const sharedWith = new Map<string, Person[]>();
  for (const link of eventLinks) {
    const other = link.person_id === person.id ? undefined : index.byId.get(link.person_id);
    if (other) sharedWith.set(link.event_id, [...(sharedWith.get(link.event_id) ?? []), other]);
  }
  const shareCandidates = [...index.byId.values()]
    .filter((other) => other.id !== person.id)
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));

  const set = (patch: Partial<PersonFields>) => setDraft((current) => ({ ...current, ...patch }));
  const text = (key: Exclude<keyof PersonFields, "sex">, placeholder = "") => ({
    value: draft[key],
    placeholder,
    onChange: (e: { target: { value: string } }) => set({ [key]: e.target.value }),
    onBlur: save,
  });

  async function leave(go: () => void) {
    await save();
    go();
  }

  async function addEvent() {
    try {
      const id = await createEvent(person.id);
      await refreshEvents();
      return id;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }

  const eventName = (event: LifeEvent) => (event.title.trim() ? `"${event.title.trim()}"` : "this event");

  async function shareEvent(event: LifeEvent, personId: string) {
    await addEventPerson(event.id, personId);
    await refreshEvents();
  }

  /** Takes the event off one person's page: this person's own (`who` omitted) or someone it is shared with. */
  async function unshareEvent(event: LifeEvent, who: Person = person) {
    const ok = await confirm(
      `Remove ${eventName(event)} from ${displayName(who)}'s page? It stays on the pages of the other people it is shared with.`,
      { title: "Remove from page" },
    );
    if (!ok) return;
    await removeEventPerson(event.id, who.id);
    await Promise.all([refreshEvents(), refreshPhotos()]);
  }

  async function removeEvent(event: LifeEvent, photoCount: number) {
    const name = eventName(event);
    const others = sharedWith.get(event.id) ?? [];
    const sharedNote =
      others.length === 0 ? "" : ` It will also disappear from the page of ${others.map(displayName).join(", ")}.`;
    const photosNote =
      photoCount === 0
        ? ""
        : ` Its ${photoCount === 1 ? "photo" : `${photoCount} photos`}, and any recordings attached to them, will be deleted too.`;
    const ok = await confirm(`Delete ${name}?${sharedNote}${photosNote} This cannot be undone.`, {
      title: "Delete event",
      kind: "warning",
    });
    if (!ok) return;
    await deleteEvent(event.id);
    await Promise.all([refreshEvents(), refreshPhotos(), reload()]);
  }

  async function addPhotos(event: LifeEvent) {
    const picked = await open({
      multiple: true,
      filters: [IMAGE_FILTER],
    });
    if (!picked) return;
    try {
      let firstId: string | null = null;
      for (const path of picked) {
        const id = await importPhoto(person.id, path, event.id);
        firstId ??= id;
      }
      if (!person.portrait_media_id && firstId) await setPortrait(person.id, firstId);
    } catch (e) {
      setError(String(e));
    }
    await Promise.all([refreshPhotos(), reload()]);
  }

  async function removePhoto(photo: Media) {
    const ok = await confirm(
      "Delete this photo? The copy stored in the app, and any recordings attached to it, will be removed.",
      { kind: "warning" },
    );
    if (!ok) return;
    await deleteMedia(photo);
    await Promise.all([refreshPhotos(), reload()]);
  }

  async function choosePortrait(photo: Media) {
    await setPortrait(person.id, photo.id === person.portrait_media_id ? null : photo.id);
    await reload();
  }

  async function removePerson() {
    const ok = await confirm(
      `Delete ${displayName(person)}? Their details, their own events and photos, and their links to relatives will be removed. Events shared with other people are kept for those people. This cannot be undone.`,
      { title: "Delete person", kind: "warning" },
    );
    if (!ok) return;
    await deletePerson(person.id);
    await reload();
    onBack();
  }

  async function unlink(label: string, action: () => Promise<void>) {
    if (!(await confirm(`${label} Both people stay in the tree.`, { title: "Remove link" }))) return;
    await action();
    await reload();
  }

  const people = (ids: string[] | undefined) =>
    (ids ?? []).map((id) => index.byId.get(id)).filter((p): p is Person => !!p);

  const relatives: { title: string; members: Person[]; onUnlink?: (other: Person) => void }[] = [
    {
      title: "Parents",
      members: people(index.parentsOf.get(person.id)),
      onUnlink: (other: Person) =>
        unlink(`Remove ${displayName(other)} as a parent of ${displayName(person)}?`, () =>
          removeParentLink(other.id, person.id),
        ),
    },
    {
      title: "Partners",
      members: people(index.partnersOf.get(person.id)),
      onUnlink: (other: Person) =>
        unlink(`Remove the partnership between ${displayName(person)} and ${displayName(other)}?`, () =>
          removePartnership(person.id, other.id),
        ),
    },
    { title: "Siblings", members: people(siblingsOf(index, person.id)) },
    {
      title: "Children",
      members: people(index.childrenOf.get(person.id)),
      onUnlink: (other: Person) =>
        unlink(`Remove ${displayName(other)} as a child of ${displayName(person)}?`, () =>
          removeParentLink(person.id, other.id),
        ),
    },
  ].filter((group) => group.members.length > 0);

  return (
    <div className="relative flex h-full flex-col">
      <TopBar>
        <Button onClick={() => leave(onBack)}>← Tree</Button>
        <div className="flex-1" />
        <Button className="text-danger" onClick={removePerson}>
          Delete person
        </Button>
      </TopBar>

      <main
        ref={scroller}
        className="flex-1 overflow-y-auto px-4 pt-6 pb-12"
        onScroll={(e) => setScrolledFar(e.currentTarget.scrollTop > BACK_TO_TOP_AFTER)}
      >
        <div className="mx-auto flex max-w-[820px] flex-col gap-5">
          {error && <p className="text-danger">{error}</p>}

          <section className="flex items-center gap-5">
            <Avatar person={person} size={112} />
            <div>
              <h1 className="font-serif text-3xl font-semibold">{displayName({ ...person, ...draft })}</h1>
              <p className="mt-1 text-muted">{lifespan({ ...person, ...draft })}</p>
            </div>
          </section>

          <Card title="Details">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Given names">
                <input className={inputClass} {...text("given_name")} />
              </Field>
              <Field label="Family name">
                <input className={inputClass} {...text("family_name")} />
              </Field>
              <Field label="Sex">
                <select
                  className={inputClass}
                  value={draft.sex}
                  onChange={(e) => set({ sex: e.target.value as Sex })}
                  onBlur={save}
                >
                  <option value="unknown">Not recorded</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                </select>
              </Field>
              <span />
              <Field label="Born">
                <input className={inputClass} {...text("birth_date", "e.g. 12 Mar 1902, abt. 1850")} />
              </Field>
              <Field label="Birthplace">
                <input className={inputClass} {...text("birth_place")} />
              </Field>
              <Field label="Died">
                <input className={inputClass} {...text("death_date")} />
              </Field>
              <Field label="Place of death">
                <input className={inputClass} {...text("death_place")} />
              </Field>
            </div>
          </Card>

          {relatives.length > 0 && (
            <Card title="Family">
              {relatives.map((group) => (
                <div className="mt-2 flex items-baseline gap-3" key={group.title}>
                  <h3 className="w-[70px] text-xs text-muted">{group.title}</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {group.members.map((member) => (
                      <PersonChip
                        key={member.id}
                        person={member}
                        onOpen={() => leave(() => onNavigate(member.id))}
                        onRemove={group.onUnlink && (() => group.onUnlink!(member))}
                        removeTitle="Remove this link"
                      />
                    ))}
                  </div>
                </div>
              ))}
            </Card>
          )}

          <Card title="Their story">
            <textarea
              className={`${inputClass} resize-y font-serif text-base leading-[1.6]`}
              rows={12}
              {...text("biography", "Write about their life: where they lived, what they did, the stories passed down…")}
            />
          </Card>

          <EventsCard
            events={events}
            photos={photos}
            sharedWith={sharedWith}
            candidates={shareCandidates}
            photoActions={{
              portraitId: person.portrait_media_id,
              onOpen: openPhoto,
              onPortrait: choosePortrait,
              onDelete: removePhoto,
              onCaption: (photo, caption) =>
                updateCaption(photo.id, caption).then(refreshPhotos, (e) => setError(String(e))),
            }}
            onAdd={addEvent}
            onAddPhotos={addPhotos}
            onAddPerson={shareEvent}
            onRemovePerson={unshareEvent}
            onLeave={unshareEvent}
            onDelete={removeEvent}
            onOpenPerson={(id) => leave(() => onNavigate(id))}
            onChanged={refreshEvents}
            onError={setError}
          />
        </div>
      </main>

      {scrolledFar && (
        <Button
          className="absolute right-6 bottom-6 shadow-lg"
          onClick={() => scroller.current?.scrollTo({ top: 0, behavior: "smooth" })}
        >
          ↑ Back to top
        </Button>
      )}
    </div>
  );
}
