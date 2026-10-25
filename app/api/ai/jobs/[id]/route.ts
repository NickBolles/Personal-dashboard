import { api } from "@/server/http/api";
import { ownedJob, toJobView } from "@/server/ai/jobs";

export const dynamic = "force-dynamic";

export const GET = api<undefined, { id: string }>(({ user, params }) => toJobView(ownedJob(user.id, params.id)), { capAll: ["work.use", "work.ai"] });
