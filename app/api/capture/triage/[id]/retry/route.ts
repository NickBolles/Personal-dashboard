import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { retryTriage } from "@/server/capture/triage";

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const decode = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** Retry a failed capture triage (id = triage row or inbox entry). */
export const POST = api<undefined, { id: string }>(
  async ({ params, user, correlationId }) => {
    const id = decode(params.id);
    if (!ID.test(id)) throw new HttpError(404, "not_found", "Not found");
    return { triage: retryTriage(user, id, correlationId) };
  },
  { cap: "work.ai" },
);
