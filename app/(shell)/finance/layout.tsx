import { requirePage } from "@/server/auth/page";
import { FinanceShell } from "@/components/finance/FinanceNav";

export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  await requirePage("finance.view");
  return <FinanceShell>{children}</FinanceShell>;
}
