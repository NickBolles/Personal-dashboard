import "server-only";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser, isClaimed } from "@/server/auth";

/** For module pages: signed in and holding one of `caps`, or a 404 (we don't reveal what exists). */
export async function requirePage(...caps: string[]) {
  const user = await getCurrentUser();
  if (!user) redirect(isClaimed() ? "/login" : "/onboarding");
  if (caps.length && !caps.some((c) => user.capabilities.has(c))) notFound();
  return user;
}
