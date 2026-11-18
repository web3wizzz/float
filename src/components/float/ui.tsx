import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import type { ConsoleTab } from "@/lib/float/tabs";

export function Mark({ className = "size-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="4" className="fill-abyss stroke-signal" strokeWidth="1.5" />
      <path d="M6 20.5h20" className="stroke-signal" strokeWidth="1.75" fill="none" />
      <circle cx="15" cy="15" r="4.1" className="fill-signal" />
      <path d="M24 15.5v8" className="stroke-signal" strokeWidth="1.75" fill="none" />
    </svg>
  );
}

type Tone = "desk" | "slip";
type Variant = "primary" | "secondary" | "danger";

const variantClass: Record<Tone, Record<Variant, string>> = {
  desk: {
    primary: "btn-primary bg-signal text-signal-ink",
    secondary: "btn-desk border border-line text-foam",
    danger: "btn-danger-desk border border-bad text-bad",
  },
  slip: {
    primary: "btn-primary bg-signal text-signal-ink",
    secondary: "btn-slip border border-line-slip text-ink",
    danger: "btn-danger-slip border border-bad-ink text-bad-ink",
  },
};

export function Btn({
  tone = "slip",
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; variant?: Variant }) {
  return (
    <button
      type={type}
      className={`pressable inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium disabled:opacity-60 ${variantClass[tone][variant]} ${className}`}
      {...props}
    />
  );
}

export function Sheet({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="slip overflow-hidden rounded-sm bg-slip text-ink shadow-[0_18px_40px_rgba(0,0,0,0.32)]">
      <div className="h-0.5 bg-signal" aria-hidden="true" />
      <div className="px-4 py-5 sm:px-6" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

export function Rule({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 border-t border-line-slip pt-5">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={id} className="block text-sm text-slip-muted">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

export function NavLink({
  id,
  label,
  icon: Icon,
  current,
  layout,
}: {
  id: ConsoleTab;
  label: string;
  icon: LucideIcon;
  current: boolean;
  layout: "side" | "bar";
}) {
  const icon = <Icon strokeWidth={current ? 2 : 1.5} className="size-5" aria-hidden="true" />;
  if (layout === "side") {
    return (
      <Link
        to="/"
        search={{ tab: id }}
        aria-current={current ? "page" : undefined}
        className={`nav-link flex min-h-11 items-center gap-3 rounded-md px-3 text-sm ${
          current ? "bg-abyss text-foam" : "text-mist"
        }`}
      >
        <span className={current ? "text-signal" : ""}>{icon}</span>
        {label}
      </Link>
    );
  }
  return (
    <Link
      to="/"
      search={{ tab: id }}
      aria-current={current ? "page" : undefined}
      className={`nav-link flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs ${
        current ? "text-foam" : "text-mist"
      }`}
    >
      <span className={current ? "text-signal" : ""}>{icon}</span>
      {label}
    </Link>
  );
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="py-2">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-slip-muted">{children}</p>
    </div>
  );
}
