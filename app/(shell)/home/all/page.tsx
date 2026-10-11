import { AllItemsView } from "./AllItemsView";

export const metadata = { title: "All of Home" };

const BUCKETS = ["now", "today", "upcoming", "backlog"] as const;
type Bucket = (typeof BUCKETS)[number];

export default async function AllItemsPage({ searchParams }: { searchParams: Promise<{ bucket?: string }> }) {
  const sp = await searchParams;
  const bucket: Bucket = BUCKETS.includes(sp.bucket as Bucket) ? (sp.bucket as Bucket) : "backlog";
  return <AllItemsView initial={bucket} />;
}
