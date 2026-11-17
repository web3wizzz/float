import { createFileRoute } from "@tanstack/react-router";
import { FloatApp } from "@/components/float/console";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <FloatApp />;
}
