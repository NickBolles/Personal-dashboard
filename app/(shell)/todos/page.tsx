import { requirePage } from "@/server/auth/page";
import { TodosView } from "./TodosView";

export const metadata = { title: "Todos" };

export default async function TodosPage() {
  await requirePage("todos.view");
  return <TodosView />;
}
