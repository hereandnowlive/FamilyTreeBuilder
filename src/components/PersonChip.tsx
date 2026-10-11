import { displayName } from "../relations";
import type { Person } from "../types";
import { Avatar } from "./Avatar";

interface Props {
  person: Person;
  onOpen: () => void;
  /** Shows a × that calls this; leave out for a chip that cannot be removed. */
  onRemove?: () => void;
  removeTitle?: string;
}

/** A pill with a person's portrait and name that opens their page, optionally with a remove button. */
export function PersonChip({ person, onOpen, onRemove, removeTitle }: Props) {
  return (
    <span className="inline-flex overflow-hidden rounded-full border border-line">
      <button className="flex cursor-pointer items-center gap-1.5 py-0.5 pr-2.5 pl-1 hover:bg-paper" onClick={onOpen}>
        <Avatar person={person} size={24} />
        {displayName(person)}
      </button>
      {onRemove && (
        <button
          className="cursor-pointer py-0.5 pr-2 pl-1.5 text-muted hover:bg-paper"
          title={removeTitle}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </span>
  );
}
