import { api } from "@/server/http/api";
import { referenceOptions } from "@/server/references";

export const dynamic = "force-dynamic";

/** The composer's `@` picker: typed sections, `type:` filters (`@chat:`, `@area:`…). Never Finance. */
export const GET = api(({ req, user }) => referenceOptions(user, req.nextUrl.searchParams.get("q") ?? ""), { cap: "hermes.chat" });
