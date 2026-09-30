import { ReceiptView } from "./receipt-view";

export const dynamic = "force-dynamic";

type ReceiptPageProps = {
  params: Promise<{ txHash: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ReceiptPage({ params, searchParams }: ReceiptPageProps) {
  const { txHash } = await params;
  const query = await searchParams;

  const rawNote = query.note;
  const note = Array.isArray(rawNote) ? (rawNote[0] ?? "") : (rawNote ?? "");

  return <ReceiptView txHash={txHash} urlNote={note} />;
}
