"use client";

import dynamic from "next/dynamic";
import { Page, PageHeader } from "@/components/ui";
import { LoadingState } from "@/components/ui/LoadingState";

// Keep the builder (and its preview/review dependencies) out of the route entry chunk.
// SSR stays on: both the builder and the chunk fallback include a page h1.
const Builder = dynamic(() => import("./WorkflowBuilder").then((m) => m.WorkflowBuilder), {
  ssr: true,
  loading: () => (
    <Page width="wide">
      <PageHeader title="Workflow builder" />
      <LoadingState label="Loading workflow builder…" />
    </Page>
  ),
});

export function WorkflowBuilderEntry(props: { slug?: string; fromChat?: string }) {
  return <Builder {...props} />;
}
