-- A major event in one person's life (a wedding, a move, military service).
-- event_date is free text, like the dates on person.
CREATE TABLE event (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '',
    event_date  TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX event_person ON event(person_id);

-- A photo optionally belongs to one event. NULL means it is one of the
-- person's general photos. Deleting an event keeps its photos.
ALTER TABLE media ADD COLUMN event_id TEXT REFERENCES event(id) ON DELETE SET NULL;
CREATE INDEX media_event ON media(event_id);

-- The longer text on a photo's own page. caption stays as its short title.
ALTER TABLE media ADD COLUMN description TEXT NOT NULL DEFAULT '';

-- Recordings attached to a photo. file_name is relative to the app's media
-- directory, the same as media.file_name.
CREATE TABLE audio (
    id         TEXT PRIMARY KEY,
    media_id   TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    file_name  TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audio_media ON audio(media_id);
