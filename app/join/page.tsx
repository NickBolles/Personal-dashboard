import { redirect } from "next/navigation";
import { config } from "@/server/config";
import { JoinForm } from "./JoinForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Join Jarvis" };

export default async function JoinPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  if (config.authMode === "proxy") redirect("/home");
  const { code } = await searchParams;
  return <JoinForm initialCode={code ?? ""} />;
}
