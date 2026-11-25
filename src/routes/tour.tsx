import { createFileRoute } from "@tanstack/react-router";
import { FloatApp } from "@/components/float/console";

export const Route = createFileRoute("/tour")({
  component: TourPage,
});

function TourPage() {
  return <FloatApp surface="tour" />;
}
