import { createFileRoute } from "@tanstack/react-router";
import { FloatApp } from "@/components/float/console";
import { TAB_TITLE, parseTab } from "@/lib/float/tabs";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseTab(search.tab),
  }),
  head: ({ match }) => {
    const tab = parseTab(match.search.tab);
    return {
      meta: [{ title: `${TAB_TITLE[tab]} — Float` }],
    };
  },
  component: Home,
});

function Home() {
  const { tab } = Route.useSearch();
  return <FloatApp tab={tab} />;
}
