import { requirePage } from "@/server/auth/page";
import { PeopleView } from "./PeopleView";

export const metadata = { title: "People" };

export default async function PeoplePage() {
  await requirePage("admin");
  return <PeopleView />;
}
