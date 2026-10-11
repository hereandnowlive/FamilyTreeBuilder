-- The separate Photos section is gone: every photo now belongs to an event.
-- Photos that are not in one yet go into a new "Photos" event for their person.
-- (media.event_id stays nullable in the schema, but the app always sets it.)
INSERT INTO event (id, person_id, title)
SELECT lower(hex(randomblob(16))), person_id, 'Photos'
FROM media WHERE event_id IS NULL GROUP BY person_id;

-- The event just inserted for a person is their one with the highest rowid.
UPDATE media
SET event_id = (
    SELECT id FROM event
    WHERE event.person_id = media.person_id
    ORDER BY event.rowid DESC LIMIT 1
)
WHERE event_id IS NULL;
