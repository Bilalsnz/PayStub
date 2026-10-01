/**
 * The invoice book. localStorage only — no backend, no database, no account.
 *
 * The stored `status` is a convenience cache, never the source of truth: an
 * invoice is PAID when the chain says a `transferWithMemo` carrying its id
 * landed on its payee address. See `findInvoicePayment` in lib/pathusd.ts.
 */

const KEY = "paystub.invoices.v1";
const SEQ_KEY = "paystub.seq.v1";

/** First id handed out by hand. The demo triad owns 0841–0843. */
const SEQ_START = 844;
export const DEMO_SEQ_START = 841;

export type InvoiceStatus = "unpaid" | "paid";

export type Invoice = {
  /** Short and human: INV-0841. This exact string is what goes in the memo. */
  id: string;
  payee: `0x${string}`;
  /** Display string, e.g. "40.00". The chain gets parseUnits(amount, 6). */
  amount: string;
  note: string;
  createdAt: string;
  status: InvoiceStatus;
  txHash?: `0x${string}`;
  /** Display only — "Today" / "This week". Never enforced anywhere. */
  due?: string;
};

export const INVOICE_ID_PATTERN = /^INV-\d{3,6}$/;

export function isInvoiceId(value: string): boolean {
  return INVOICE_ID_PATTERN.test(value);
}

/**
 * Pulls an invoice id out of whatever the user pasted — a bare id, a share
 * link, or a full URL with query params. Returns null if there is no id in it.
 */
export function parseInvoiceInput(input: string): string | null {
  const match = input.trim().match(/INV-\d{3,6}/i);
  return match ? match[0].toUpperCase() : null;
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private mode or a full quota. The invoice still works from its URL. */
  }
}

export function listInvoices(): Invoice[] {
  const all = read<Invoice[]>(KEY, []);
  if (!Array.isArray(all)) return [];
  return all
    .filter((invoice) => invoice && typeof invoice.id === "string")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getInvoice(id: string): Invoice | null {
  const wanted = id.trim().toUpperCase();
  return listInvoices().find((invoice) => invoice.id.toUpperCase() === wanted) ?? null;
}

export function saveInvoice(invoice: Invoice): void {
  const others = listInvoices().filter((existing) => existing.id !== invoice.id);
  write(KEY, [invoice, ...others]);
}

export function markPaid(id: string, txHash: `0x${string}`): void {
  const existing = getInvoice(id);
  if (!existing) return;
  saveInvoice({ ...existing, status: "paid", txHash });
}

export function nextInvoiceId(): string {
  const current = read<number>(SEQ_KEY, SEQ_START);
  const next = Number.isFinite(current) && current >= SEQ_START ? current : SEQ_START;
  write(SEQ_KEY, next + 1);
  return `INV-${String(next).padStart(4, "0")}`;
}

export function createInvoice(input: {
  payee: `0x${string}`;
  amount: string;
  note: string;
  due?: string;
}): Invoice {
  const invoice: Invoice = {
    id: nextInvoiceId(),
    payee: input.payee,
    amount: input.amount,
    note: input.note,
    due: input.due || undefined,
    createdAt: new Date().toISOString(),
    status: "unpaid",
  };
  saveInvoice(invoice);
  return invoice;
}

/**
 * The share link carries the invoice itself.
 *
 * The client's phone has none of the freelancer's localStorage, so the URL is
 * what tells their browser the amount, the payee and the job. The chain
 * supplies the paid/unpaid truth. Paperwork from the URL, proof from the chain.
 */
export function shareUrl(invoice: Invoice, origin: string): string {
  const params = new URLSearchParams({
    to: invoice.payee,
    amt: invoice.amount,
    note: invoice.note,
    at: String(Math.floor(new Date(invoice.createdAt).getTime() / 1000)),
  });
  if (invoice.due) params.set("due", invoice.due);
  return `${origin}/i/${invoice.id}?${params.toString()}`;
}

/** Rebuilds an invoice from share-link params, for a browser that has no book. */
export function invoiceFromParams(
  id: string,
  params: { to: string; amt: string; note: string; at: string; due: string },
): Invoice | null {
  if (!isInvoiceId(id)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.to)) return null;

  const created = Number(params.at);
  return {
    id: id.toUpperCase(),
    payee: params.to as `0x${string}`,
    amount: params.amt,
    note: params.note,
    due: params.due || undefined,
    createdAt: Number.isFinite(created)
      ? new Date(created * 1000).toISOString()
      : new Date().toISOString(),
    status: "unpaid",
  };
}

export const DEMO_ROWS = [
  { amount: "40.00", note: "Logo for flyer" },
  { amount: "25.00", note: "Caption rewrite" },
  { amount: "15.00", note: "Thumbnail crop" },
] as const;

/**
 * One tap, three unpaid invoices — so a judge sees a book without typing.
 * Payee is the connected wallet, which makes the demo self-contained: the same
 * wallet can then pay one. The UI says so out loud rather than pretending.
 */
export function seedDemoInvoices(payee: `0x${string}`): Invoice[] {
  const now = Date.now();

  const created = DEMO_ROWS.map((row, index) => {
    const invoice: Invoice = {
      id: `INV-${String(DEMO_SEQ_START + index).padStart(4, "0")}`,
      payee,
      amount: row.amount,
      note: row.note,
      createdAt: new Date(now - (DEMO_ROWS.length - index) * 1000).toISOString(),
      status: "unpaid",
    };
    saveInvoice(invoice);
    return invoice;
  });

  // Keep the counter above the demo ids so a hand-made invoice cannot collide.
  const current = read<number>(SEQ_KEY, SEQ_START);
  const floor = DEMO_SEQ_START + DEMO_ROWS.length;
  if (!Number.isFinite(current) || current < floor) write(SEQ_KEY, floor);

  return created;
}
