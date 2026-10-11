// Field names mirror the SQLite columns (see src-tauri/migrations) so rows can be used as-is.

export type Sex = "male" | "female" | "unknown";

export interface PersonFields {
  given_name: string;
  family_name: string;
  sex: Sex;
  birth_date: string;
  birth_place: string;
  death_date: string;
  death_place: string;
  biography: string;
}

export interface Person extends PersonFields {
  id: string;
  portrait_media_id: string | null;
  /** File name of the portrait photo, joined in from the media table. */
  portrait_file: string | null;
}

export interface Partnership {
  id: string;
  person_a_id: string;
  person_b_id: string;
}

export interface ParentLink {
  parent_id: string;
  child_id: string;
}

export interface Media {
  id: string;
  /** The major event this photo belongs to. */
  event_id: string;
  file_name: string;
  /** Short title shown under the thumbnail. */
  caption: string;
  /** Longer text shown on the photo's own page. */
  description: string;
}

export interface EventFields {
  title: string;
  event_date: string;
  description: string;
}

/**
 * A major event, shared by one or more people. Named LifeEvent because Event is the DOM type.
 * Who is in it comes from EventLink rows, not from a field here.
 */
export interface LifeEvent extends EventFields {
  id: string;
}

/** One person's membership of an event (the `event_participant` table). */
export interface EventLink {
  event_id: string;
  person_id: string;
}

/** An audio file attached to a photo (the `audio` table). */
export interface Recording {
  id: string;
  media_id: string;
  file_name: string;
  title: string;
}

/**
 * A file attached to a person, such as a PDF or a Word document (the `document` table).
 * Named PersonDocument because Document is the DOM type.
 */
export interface PersonDocument {
  id: string;
  person_id: string;
  file_name: string;
  /** The name shown in the app. Starts as the original file's name. */
  title: string;
}

export interface TreeData {
  people: Person[];
  partnerships: Partnership[];
  parentLinks: ParentLink[];
}

export type RelationKind = "parent" | "partner" | "child" | "sibling";

export const EMPTY_PERSON: PersonFields = {
  given_name: "",
  family_name: "",
  sex: "unknown",
  birth_date: "",
  birth_place: "",
  death_date: "",
  death_place: "",
  biography: "",
};
