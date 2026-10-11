import { Thumbnail } from "../components/Thumbnail";
import { Button, controlClass } from "../components/ui";
import type { Media } from "../types";

/** What a grid needs from the person page; the same for every event's grid. */
export interface PhotoActions {
  portraitId: string | null;
  onOpen: (photo: Media) => void;
  onPortrait: (photo: Media) => void;
  onDelete: (photo: Media) => void;
  onCaption: (photo: Media, caption: string) => void;
}

export function PhotoGrid({ photos, actions }: { photos: Media[]; actions: PhotoActions }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3.5">
      {photos.map((photo) => (
        <figure className="flex flex-col gap-1.5" key={photo.id}>
          <Thumbnail
            className="aspect-square w-full cursor-pointer rounded-lg bg-paper object-cover hover:opacity-90"
            fileName={photo.file_name}
            alt={photo.caption}
            title="Open this photo's page"
            onClick={() => actions.onOpen(photo)}
          />
          <input
            className={`${controlClass} border-transparent bg-transparent px-1.5 py-1 text-[13px] hover:border-line`}
            placeholder="Add a caption…"
            defaultValue={photo.caption}
            onBlur={(e) => e.target.value !== photo.caption && actions.onCaption(photo, e.target.value)}
          />
          <div className="flex justify-between">
            <Button variant="ghost" size="xs" onClick={() => actions.onPortrait(photo)}>
              {photo.id === actions.portraitId ? "★ Portrait" : "☆ Use as portrait"}
            </Button>
            <Button variant="ghost" size="xs" className="text-danger" onClick={() => actions.onDelete(photo)}>
              Delete
            </Button>
          </div>
        </figure>
      ))}
    </div>
  );
}
