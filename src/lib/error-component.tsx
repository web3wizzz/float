import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";

const FALLBACK_MESSAGE = "Something unexpected happened. Reload the page and try the action again.";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return FALLBACK_MESSAGE;
}

export function AppErrorComponent({ error }: ErrorComponentProps) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-abyss px-6 text-center text-foam">
      <TriangleAlert className="size-8 text-bad" strokeWidth={1.5} aria-hidden="true" />
      <h1 className="text-lg font-semibold">The console hit an error</h1>
      <p className="max-w-md text-sm break-words text-mist">{errorMessage(error)}</p>
    </main>
  );
}
