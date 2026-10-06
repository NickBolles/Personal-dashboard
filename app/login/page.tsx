import { redirect } from "next/navigation";
import { getCurrentUser, isClaimed } from "@/server/auth";
import { config } from "@/server/config";
import { isMultiPerson } from "@/server/people";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!isClaimed() && config.authMode === "local") redirect("/onboarding");
  const { next } = await searchParams;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/home";
  if (await getCurrentUser()) redirect(safeNext);
  if (config.authMode === "proxy") {
    return (
      <main id="main" className="mx-auto max-w-md p-6">
        <h1 className="text-2xl font-semibold">Sign-in required</h1>
        <p className="mt-2 text-muted">
          Jarvis is configured to trust your reverse proxy for sign-in, but no identity header arrived. Open Jarvis through its authenticated URL.
        </p>
      </main>
    );
  }
  return <LoginForm next={safeNext} askName={isMultiPerson()} />;
}
