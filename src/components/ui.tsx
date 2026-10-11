import type { ComponentProps, ReactNode } from "react";

// Class names are written out in full so Tailwind's scanner can find them.
const BUTTON_VARIANTS = {
  default: "border-line bg-surface enabled:hover:border-accent",
  primary: "border-accent bg-accent text-accent-ink",
  ghost: "border-transparent enabled:hover:border-accent",
};

const BUTTON_SIZES = {
  md: "px-3 py-1.5",
  sm: "px-2 py-1 text-xs",
  xs: "px-1.5 py-0.5 text-xs",
};

interface ButtonProps extends ComponentProps<"button"> {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
}

/**
 * The standard button. `className` is for extras the variants do not set (text-danger,
 * whitespace-nowrap); it cannot override border, background or padding.
 */
export function Button({ variant = "default", size = "md", className = "", ...props }: ButtonProps) {
  return (
    <button
      className={`cursor-pointer rounded-md border disabled:cursor-default disabled:opacity-45 ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
      {...props}
    />
  );
}

/** One button of a joined-up row where exactly one choice is active. */
export function segmentClass(active: boolean): string {
  return `flex-1 cursor-pointer border px-3 py-1.5 whitespace-nowrap first:rounded-l-md last:rounded-r-md last:border-l-0 ${
    active ? "border-accent bg-accent text-accent-ink" : "border-line bg-surface hover:border-accent"
  }`;
}

/** Shape and focus ring shared by every input, select and textarea. */
export const controlClass = "w-full rounded-md border focus:border-accent focus:outline-2 focus:outline-accent/45";

/** The standard boxed form control. */
export const inputClass = `${controlClass} border-line bg-surface px-2 py-1.5`;

/** A form control with its label above it. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

export function TopBar({ children }: { children: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2.5">{children}</header>
  );
}

/** A titled panel on the person page. `action` sits opposite the title. */
export function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[10px] border border-line bg-surface px-5 py-4.5">
      <div className="mb-3 flex items-start justify-between">
        <h2 className="font-serif text-[17px] font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
