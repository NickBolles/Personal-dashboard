import { CheckinView } from "./CheckinView";

export const metadata = { title: "Check-in" };

export default async function CheckinPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CheckinView id={id} />;
}
