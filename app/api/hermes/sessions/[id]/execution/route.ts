import { api } from "@/server/http/api";
import { chatExecution } from "@/server/chat/execution";

export const dynamic = "force-dynamic";
export const GET = api<undefined, { id: string }>(({ user, params }) => chatExecution(user, params.id), { cap: "hermes.chat" });
