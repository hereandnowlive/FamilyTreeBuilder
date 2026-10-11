-- Files attached to a person: a birth certificate as a PDF, a letter typed up
-- in Word. file_name is relative to the app's media directory, the same as
-- media.file_name, so family files carry documents without extra work.
-- title is the name shown in the app; it starts as the original file's name.
CREATE TABLE document (
    id         TEXT PRIMARY KEY,
    person_id  TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    file_name  TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX document_person ON document(person_id);
