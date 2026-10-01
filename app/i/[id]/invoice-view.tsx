"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";

import { PATHUSD_ABI } from "@/lib/abi";
import { tempoTestnet } from "@/lib/chains";
import { copyText, formatTime, shortAddress } from "@/lib/format";
import {
  getInvoice,
  invoiceFromParams,
  isInvoiceId,
  markPaid,
  type Invoice,
} from "@/lib/invoices";
import {
  PATHUSD_ADDRESS,
  PATHUSD_LABEL,
  blockTimestamp,
  explorerTxUrl,
  findInvoicePayment,
  packMemo,
  parseAmount,
  waitForPayment,
  type InvoicePayment,
} from "@/lib/pathusd";
import {
  SWITCH_HELP,
  ensureTempoChain,
  errorMessage,
  isUserRejection,
  providerFor,
} from "@/lib/wagmi";

const CARD = "rounded-2xl border border-line bg-card p-5";
const PRIMARY =
  "w-full rounded-2xl bg-accent px-4 py-4 text-[16px] font-semibold text-white disabled:opacity-40";
const SECONDARY =
  "w-full rounded-2xl border border-line bg-card px-4 py-3.5 text-[15px] font-semibold text-ink";

/**
 * `scanning` is only ever the first look. The 10-second poll below sweeps
 * silently so the page does not blink between unpaid and paid.
 */
type Scan =
  | { kind: "scanning" }
  | { kind: "unpaid" }
  | { kind: "paid"; payment: InvoicePayment; timestamp: bigint | null }
  | { kind: "error"; detail: string };

export function InvoiceView({
  invoiceId,
  paramTo,
  paramAmount,
  paramNote,
  paramAt,
  paramDue,
}: {
  invoiceId: string;
  paramTo: string;
  paramAmount: string;
  paramNote: string;
  paramAt: string;
  paramDue: string;
}) {
  const [mounted, setMounted] = useState(false);
  /** undefined = still resolving, null = no such invoice. */
  const [invoice, setInvoice] = useState<Invoice | null | undefined>(undefined);
  const [scan, setScan] = useState<Scan>({ kind: "scanning" });
  const [payError, setPayError] = useState<string | null>(null);
  const [payStatus, setPayStatus] = useState<string | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [copied, setCopied] = useState<"link" | "payee" | null>(null);

  const { address, connector, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();

  /**
   * The book on this device first, then the share link. The client's phone has
   * none of the freelancer's localStorage, so for them the URL is the invoice.
   */
  useEffect(() => {
    setMounted(true);
    const local = isInvoiceId(invoiceId) ? getInvoice(invoiceId) : null;
    const fromUrl = invoiceFromParams(invoiceId, {
      to: paramTo,
      amt: paramAmount,
      note: paramNote,
      at: paramAt,
      due: paramDue,
    });
    setInvoice(local ?? fromUrl ?? null);
  }, [invoiceId, paramTo, paramAmount, paramNote, paramAt, paramDue]);

  const runScan = useCallback(
    async (showSpinner: boolean): Promise<boolean> => {
      if (!invoice) return false;
      if (showSpinner) setScan({ kind: "scanning" });

      try {
        const since = Math.floor(new Date(invoice.createdAt).getTime() / 1000);
        const payment = await findInvoicePayment({
          invoiceId: invoice.id,
          payee: invoice.payee,
          since,
        });

        if (!payment) {
          // A miss must never take a paid invoice back to UNPAID. The node that
          // answers this query is not necessarily the one that served the
          // receipt, and logs can trail a beat behind the block.
          setScan((prev) => (prev.kind === "paid" ? prev : { kind: "unpaid" }));
          return false;
        }

        const timestamp = await blockTimestamp(payment.blockNumber);
        setScan({ kind: "paid", payment, timestamp });
        markPaid(invoice.id, payment.txHash);
        return true;
      } catch (error) {
        if (showSpinner) setScan({ kind: "error", detail: errorMessage(error) });
        return false;
      }
    },
    [invoice],
  );

  useEffect(() => {
    if (invoice === undefined || invoice === null) return;
    runScan(true);
  }, [invoice, runScan]);

  // While unpaid, keep looking. The client pays on their phone; this page
  // flips on its own without anyone touching it.
  useEffect(() => {
    if (scan.kind !== "unpaid" || !invoice) return;
    const timer = setInterval(() => runScan(false), 10_000);
    return () => clearInterval(timer);
  }, [scan.kind, invoice, runScan]);

  async function handlePay() {
    if (!invoice) return;
    setPayError(null);
    setIsPaying(true);

    try {
      await ensureTempoChain(await providerFor(connector));

      const value = parseAmount(invoice.amount);
      setPayStatus("Confirm in your wallet…");

      const hash = await writeContractAsync({
        address: PATHUSD_ADDRESS,
        abi: PATHUSD_ABI,
        functionName: "transferWithMemo",
        args: [invoice.payee, value, packMemo(invoice.id)],
        chainId: tempoTestnet.id,
      });

      setPayStatus("Confirming on Tempo…");
      await waitForPayment(hash);

      markPaid(invoice.id, hash);

      // The receipt is in hand, but the log query that proves it to the page
      // can land on a node a beat behind. Retry before ever letting an invoice
      // the user just paid read as UNPAID.
      let seen = false;
      for (let attempt = 0; attempt < 5 && !seen; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
        seen = await runScan(false);
      }
    } catch (error) {
      if (!isUserRejection(error)) {
        setPayError(errorMessage(error) || SWITCH_HELP);
      }
    } finally {
      setIsPaying(false);
      setPayStatus(null);
    }
  }

  async function copyPayee() {
    if (!invoice) return;
    if (await copyText(invoice.payee)) {
      setCopied("payee");
      setTimeout(() => setCopied(null), 2000);
    }
  }

  async function copyLink() {
    if (await copyText(window.location.href)) {
      setCopied("link");
      setTimeout(() => setCopied(null), 2000);
    }
  }

  if (!mounted || invoice === undefined) {
    return (
      <main className="mx-auto w-full max-w-[430px] px-4 pt-6 pb-16">
        <Bar />
        <div className={`mt-5 ${CARD}`}>
          <div className="h-4 w-24 rounded bg-canvas" />
          <div className="pulse mt-4 h-14 w-40 rounded bg-canvas" />
          <div className="mt-5 h-4 w-full rounded bg-canvas" />
          <div className="mt-2 h-4 w-2/3 rounded bg-canvas" />
        </div>
      </main>
    );
  }

  if (invoice === null) {
    return (
      <main className="mx-auto w-full max-w-[430px] px-4 pt-6 pb-16">
        <Bar />
        <div className={`mt-5 ${CARD}`}>
          <h1 className="text-[24px] font-semibold tracking-tight">No such invoice.</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-muted">
            This link does not carry an invoice, and this device has never seen one with that id.
            Ask for the full share link.
          </p>
          <a className={`mt-4 block text-center ${SECONDARY}`} href="/">
            Back to PayStub
          </a>
        </div>
      </main>
    );
  }

  const paid = scan.kind === "paid" ? scan : null;
  const isPayee = Boolean(
    address && address.toLowerCase() === invoice.payee.toLowerCase(),
  );
  const differs =
    paid && paid.payment.value !== safeAmount(invoice.amount)
      ? `${paid.payment.value < safeAmount(invoice.amount) ? "Less" : "More"} than the invoiced ${invoice.amount}`
      : null;

  return (
    <main className="mx-auto w-full max-w-[430px] px-4 pt-6 pb-16">
      <Bar />

      <div className={`mt-5 ${CARD}`}>
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[15px] font-semibold tracking-tight">{invoice.id}</span>
          <StatusPill paid={Boolean(paid)} />
        </div>

        <div className="mt-5 flex items-baseline gap-1.5">
          <span className="text-[26px] font-semibold text-muted">$</span>
          <span className="text-[52px] leading-none font-semibold tracking-tight tabular-nums">
            {invoice.amount}
          </span>
        </div>
        <div className="mt-1.5 text-[13px] text-muted">{PATHUSD_LABEL}</div>

        <p className="mt-5 text-[16px] leading-snug text-ink">{invoice.note}</p>

        <dl className="mt-5 space-y-3 border-t border-line pt-5">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
              Payee
            </dt>
            <dd className="flex items-center gap-2">
              <span className="font-mono text-[13px]">{shortAddress(invoice.payee, 6)}</span>
              <button
                type="button"
                onClick={copyPayee}
                className="text-[11px] font-semibold text-accent underline"
              >
                {copied === "payee" ? "copied" : "copy"}
              </button>
            </dd>
          </div>
          {invoice.due ? <Row label="Due" value={invoice.due} /> : null}
          <Row label="Created" value={formatTime(Math.floor(new Date(invoice.createdAt).getTime() / 1000))} />
        </dl>

        {paid ? (
          <dl className="mt-5 space-y-3 border-t border-line pt-5">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
                Payer
              </dt>
              <dd className="font-mono text-[13px]">{shortAddress(paid.payment.from, 6)}</dd>
            </div>
            <Row label="Paid" value={formatTime(paid.timestamp)} />
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
                Memo
              </dt>
              <dd className="font-mono text-[13px]">{paid.payment.invoiceId}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
                Transaction
              </dt>
              <dd className="font-mono text-[13px]">{shortAddress(paid.payment.txHash, 6)}</dd>
            </div>
            {differs ? <p className="text-[12px] text-muted">{differs}.</p> : null}
          </dl>
        ) : null}
      </div>

      {paid ? (
        <div className={`fade-in mt-4 ${CARD}`}>
          <a
            className={PRIMARY + " block text-center"}
            href={explorerTxUrl(paid.payment.txHash)}
            target="_blank"
            rel="noreferrer"
          >
            Open explorer
          </a>
          <button type="button" className={`mt-2 ${SECONDARY}`} onClick={copyLink}>
            {copied === "link" ? "Link copied" : "Copy receipt link"}
          </button>
          <p className="mt-3 text-center text-[11px] leading-relaxed text-muted">
            Matched by the invoice id inside the TIP-20 memo — not by a database of ours.
          </p>
        </div>
      ) : (
        <div className={`mt-4 ${CARD}`}>
          {scan.kind === "scanning" ? (
            <p className="pulse text-[13px] text-muted">Checking Tempo for this invoice…</p>
          ) : null}

          {scan.kind === "unpaid" ? (
            <>
              <div className="rounded-xl bg-canvas px-3.5 py-3">
                <div className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
                  Your wallet fills this in
                </div>
                <div className="mt-2 space-y-1.5">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[13px] text-muted">Amount</span>
                    <span className="text-[14px] font-semibold tabular-nums">
                      {invoice.amount} pathUSD
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[13px] text-muted">Memo</span>
                    <span className="font-mono text-[14px] font-semibold">{invoice.id}</span>
                  </div>
                </div>
              </div>

              {!isConnected ? (
                <p className="mt-4 text-[13px] leading-relaxed text-muted">
                  Connect a wallet on the home page to pay this invoice.
                </p>
              ) : null}

              {isConnected && isPayee ? (
                <p className="mt-4 text-[12px] leading-relaxed text-muted">
                  Demo: pay this invoice from this wallet. Normally the client pays it from theirs.
                </p>
              ) : null}

              <button
                type="button"
                onClick={handlePay}
                disabled={!isConnected || isPaying}
                className={`mt-4 ${PRIMARY}`}
              >
                {payStatus ?? (isPaying ? "Working…" : "Pay this invoice")}
              </button>
            </>
          ) : null}

          {scan.kind === "error" ? (
            <>
              <h2 className="text-[18px] font-semibold tracking-tight">Could not reach Tempo.</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{scan.detail}</p>
              <button type="button" className={`mt-4 ${SECONDARY}`} onClick={() => runScan(true)}>
                Try again
              </button>
            </>
          ) : null}

          {payError ? (
            <p className="mt-3 rounded-xl bg-warn-bg px-3.5 py-3 text-[13px] leading-relaxed text-warn-ink">
              {payError}
            </p>
          ) : null}
        </div>
      )}

      <footer className="mt-8 text-center text-[11px] leading-relaxed text-muted">
        Tempo Moderato testnet · not financial advice · World's Fair build
      </footer>
    </main>
  );
}

/** Bad input must not crash the "differs" check. */
function safeAmount(amount: string): bigint {
  try {
    return parseAmount(amount);
  } catch {
    return 0n;
  }
}

function StatusPill({ paid }: { paid: boolean }) {
  return (
    <span
      className={`rounded-md px-2.5 py-1 text-[10px] font-semibold tracking-[0.14em] uppercase ${
        paid ? "bg-ok text-ink" : "border border-line bg-canvas text-muted"
      }`}
    >
      {paid ? "Paid" : "Unpaid"}
    </span>
  );
}

function Bar() {
  return (
    <header className="flex items-baseline justify-between">
      <a href="/" className="text-[16px] font-semibold tracking-tight text-ink">
        PayStub
      </a>
      <span className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
        Tempo Moderato
      </span>
    </header>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd className="text-right text-[13px]">{value}</dd>
    </div>
  );
}
