import { InvoiceView } from "./invoice-view";

export const dynamic = "force-dynamic";

type InvoicePageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function InvoicePage({ params, searchParams }: InvoicePageProps) {
  const { id } = await params;
  const query = await searchParams;

  return (
    <InvoiceView
      invoiceId={id}
      paramTo={one(query.to)}
      paramAmount={one(query.amt)}
      paramNote={one(query.note)}
      paramAt={one(query.at)}
      paramDue={one(query.due)}
    />
  );
}
