import { z } from "zod";
import { api } from "@/server/http/api";
import { createAccount, listAccounts } from "@/server/finance/accounts";
import { accountInput } from "@/lib/finance/schemas";

export const dynamic = "force-dynamic";

export const GET = api(({ req }) => ({ accounts: listAccounts(req.nextUrl.searchParams.get("archived") === "1") }), { cap: "finance.view" });

export const POST = api<z.infer<typeof accountInput>>(({ body, user, correlationId }) => createAccount(body, user.id, correlationId), {
  cap: "finance.edit",
  body: accountInput,
});
