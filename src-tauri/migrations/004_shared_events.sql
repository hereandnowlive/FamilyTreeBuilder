-- An event can now be shared by several people. This table is the source of
-- truth for who is in an event.
CREATE TABLE event_participant (
    event_id  TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, person_id)
);
CREATE INDEX event_participant_person ON event_participant(person_id);

INSERT INTO event_participant (event_id, person_id)
SELECT id, person_id FROM event;

-- event.person_id and media.person_id stay, because SQLite cannot drop a
-- column that has a foreign key. They no longer say whose page something is
-- on. Each must simply point at some current participant of the event: both
-- cascade on delete, so the app moves them to another participant before a
-- person is removed from a shared event or deleted.
