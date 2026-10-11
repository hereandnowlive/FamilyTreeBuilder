import { initials } from "../relations";
import type { Person } from "../types";
import { useThumbnail } from "./Thumbnail";

export function Avatar({ person, size }: { person: Person; size: number }) {
  const src = useThumbnail(person.portrait_file);
  const style = { width: size, height: size, fontSize: size * 0.38 };
  return person.portrait_file ? (
    <img
      className="flex-none rounded-full bg-paper object-cover"
      style={style}
      src={src}
      alt=""
      decoding="async"
      draggable={false}
    />
  ) : (
    <div
      className="grid flex-none place-items-center rounded-full border border-line bg-paper font-serif text-muted"
      style={style}
    >
      {initials(person)}
    </div>
  );
}
