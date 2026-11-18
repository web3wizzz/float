import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { FloatApp, type Screen } from "@/components/float/console";

const screens = ["home", "send", "invoices", "agents", "activity"] as const;

function isScreen(value: unknown): value is Screen {
  return typeof value === "string" && (screens as readonly string[]).includes(value);
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    screen: isScreen(search.screen) ? search.screen : ("home" as const),
  }),
  search: {
    middlewares: [stripSearchParams({ screen: "home" })],
  },
  component: Home,
});

function Home() {
  const { screen } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <FloatApp
      screen={screen}
      onScreen={(next) => {
        void navigate({ search: { screen: next } });
      }}
    />
  );
}
