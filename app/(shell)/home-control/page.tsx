import { requirePage } from "@/server/auth/page";
import { HomeControlView, type Proposal } from "./HomeControlView";

export const metadata = { title: "Home" };

/** `?propose=<service>&data=<json>` comes from an agent's Needs-you proposal; anything malformed is ignored. */
function parseProposal(service?: string, data?: string): Proposal | undefined {
  if (!service || !/^[a-z_]{2,40}$/.test(service)) return undefined;
  let parsed: Proposal["data"];
  if (data) {
    try {
      const v = JSON.parse(data) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v))
        parsed = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string" || typeof x === "number")) as Proposal["data"];
    } catch {
      parsed = undefined;
    }
  }
  return { service, data: parsed };
}

export default async function HomeControlPage({ searchParams }: { searchParams: Promise<{ entity?: string; propose?: string; data?: string }> }) {
  await requirePage("home_assistant.view", "home_assistant.calendar");
  const { entity, propose, data } = await searchParams;
  return <HomeControlView focusEntity={entity} propose={entity ? parseProposal(propose, data) : undefined} />;
}
