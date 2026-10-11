-- Dates are free text on purpose: genealogy dates are often partial or
-- approximate ("abt. 1850", "Mar 1902").
CREATE TABLE person (
    id                TEXT PRIMARY KEY,
    given_name        TEXT NOT NULL DEFAULT '',
    family_name       TEXT NOT NULL DEFAULT '',
    sex               TEXT NOT NULL DEFAULT 'unknown',
    birth_date        TEXT NOT NULL DEFAULT '',
    birth_place       TEXT NOT NULL DEFAULT '',
    death_date        TEXT NOT NULL DEFAULT '',
    death_place       TEXT NOT NULL DEFAULT '',
    biography         TEXT NOT NULL DEFAULT '',
    portrait_media_id TEXT,
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- person_a_id is always the smaller id, so a couple can only be stored once.
CREATE TABLE partnership (
    id          TEXT PRIMARY KEY,
    person_a_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    person_b_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    UNIQUE (person_a_id, person_b_id)
);

CREATE TABLE parent_child (
    parent_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    child_id  TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX parent_child_child ON parent_child(child_id);

-- file_name is relative to the app's media directory.
CREATE TABLE media (
    id         TEXT PRIMARY KEY,
    person_id  TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    file_name  TEXT NOT NULL,
    caption    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX media_person ON media(person_id);
