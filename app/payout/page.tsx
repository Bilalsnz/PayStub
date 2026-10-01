"use client";

import { useEffect, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";

import { PATHUSD_ABI } from "@/lib/abi";
import { tempoTestnet } from "@/lib/chains";
import { shortAddress } from "@/lib/format";
import { DEMO_ROWS, DEMO_SEQ_START, listInvoices, markPaid } from "@/lib/invoices";
import {
  PATHUSD_ADDRESS,
  explorerTxUrl,
  packMemo,
  parseAddress,
  parseAmount,
  waitForPayment,
} from "@/lib/pathusd";
import {
  SWITCH_HELP,
  ensureTempoChain,
  errorMessage,
  isUserRejection,
  providerFor,
} from "@/lib/wagmi";

const CARD = "rounded-2xl border border-line bg-card p-5";
const INPUT =
  "mt-1.5 w-full rounded-xl border border-line bg-canvas px-3.5 py-2.5 font-mono text-[13px] leading-snug tracking-tight text-ink outline-none placeholder:text-muted/50 focus:border-accent";
const PRIMARY =
  "w-full rounded-2xl bg-accent px-4 py-4 text-[16px] font-semibold text-white disabled:opacity-40";

type RowStatus = "idle" | "sending" | "sent" | "failed";

type Row = {
  id: string;
  note: string;
  amount: string;
  address: string;
  status: RowStatus;
  hash?: `0x${string}`;
  error?: string;
};

/**
 * The client side of the same product: one screen, three contractors, three
 * `transferWithMemo` calls sent one after another.
 *
 * Deliberately not a batch and not a contract. Each payment is its own
 * transaction, its own memo, its own receipt — which is the point. A batched
 * transfer would collapse three invoices into one hash and undo the matching.
 */
export default function PayoutPage() {
  const [mounted, setMounted] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { address, connector, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();

  useEffect(() => {
    setMounted(true);
    const book = listInvoices();
    setRows(
      DEMO_ROWS.map((demo, index) => {
        const id = `INV-${String(DEMO_SEQ_START + index).padStart(4, "0")}`;
        const known = book.find((invoice) => invoice.id === id);
        return {
          id,
          note: known?.note ?? demo.note,
          amount: known?.amount ?? demo.amount,
          address: known?.payee ?? "",
          status: "idle" as RowStatus,
        };
      }),
    );
  }, []);

  // Prefill anything blank with the connected wallet so the run works out of
  // the box. Every row stays editable.
  useEffect(() => {
    if (!address) return;
    setRows((previous) =>
      previous.map((row) => (row.address ? row : { ...row, address })),
    );
  }, [address]);

  function patch(id: string, changes: Partial<Row>) {
    setRows((previous) =>
      previous.map((row) => (row.id === id ? { ...row, ...changes } : row)),
    );
  }

  async function payAll() {
    setError(null);
    setIsRunning(true);

    try {
      await ensureTempoChain(await providerFor(connector));
    } catch (setupError) {
      setError(errorMessage(setupError) || SWITCH_HELP);
      setIsRunning(false);
      return;
    }

    for (const row of rows) {
      if (row.status === "sent") continue;

      let to: `0x${string}`;
      let value: bigint;
      try {
        to = parseAddress(row.address);
        value = parseAmount(row.amount);
      } catch (rowError) {
        patch(row.id, { status: "failed", error: errorMessage(rowError) });
        continue;
      }

      patch(row.id, { status: "sending", error: undefined });

      try {
        const hash = await writeContractAsync({
          address: PATHUSD_ADDRESS,
          abi: PATHUSD_ABI,
          functionName: "transferWithMemo",
          args: [to, value, packMemo(row.id)],
          chainId: tempoTestnet.id,
        });

        await waitForPayment(hash);
        patch(row.id, { status: "sent", hash });
        markPaid(row.id, hash);
      } catch (rowError) {
        if (isUserRejection(rowError)) {
          // They backed out of the wallet. Stop the run rather than firing the
          // next prompt at someone who just said no.
          patch(row.id, { status: "idle", error: undefined });
          break;
        }
        patch(row.id, { status: "failed", error: errorMessage(rowError) });
      }
    }

    setIsRunning(false);
  }

  const payable = rows.filter((row) => row.status !== "sent").length;

  return (
    <main className="mx-auto w-full max-w-[430px] px-4 pt-6 pb-16">
      <header className="flex items-baseline justify-between">
        <a href="/" className="text-[16px] font-semibold tracking-tight text-ink">
          PayStub
        </a>
        <span className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
          Tempo Moderato
        </span>
      </header>

      <h1 className="mt-7 text-[30px] leading-[1.08] font-semibold tracking-tight text-ink">
        Payout run.
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">
        Three contractors, three invoices, three payments. Each memo carries its own invoice id.
      </p>

      {!mounted ? (
        <div className={`mt-5 ${CARD}`}>
          <div className="pulse h-24 w-full rounded bg-canvas" />
        </div>
      ) : !isConnected ? (
        <div className={`mt-5 ${CARD}`}>
          <p className="text-[14px] leading-relaxed text-muted">
            Connect the wallet you pay from on the home page, then come back.
          </p>
          <a className="mt-4 block text-center text-[14px] font-semibold text-accent underline" href="/">
            Back to PayStub
          </a>
        </div>
      ) : (
        <>
          <div className="mt-5 space-y-3">
            {rows.map((row) => (
              <div key={row.id} className={CARD}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[14px] font-semibold">{row.id}</span>
                  <RowPill status={row.status} />
                </div>

                <p className="mt-2 text-[14px] text-muted">{row.note}</p>

                <label className="mt-3 block">
                  <span className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
                    Paid to
                  </span>
                  <input
                    className={INPUT}
                    value={row.address}
                    onChange={(event) => patch(row.id, { address: event.target.value })}
                    placeholder="0x…"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={isRunning || row.status === "sent"}
                  />
                </label>

                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-[12px] text-muted">Memo {row.id}</span>
                  <span className="text-[15px] font-semibold tabular-nums">{row.amount}</span>
                </div>

                {row.hash ? (
                  <a
                    className="mt-3 block text-[12px] font-semibold text-accent underline"
                    href={explorerTxUrl(row.hash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(row.hash, 6)} on explorer
                  </a>
                ) : null}

                {row.error ? (
                  <p className="mt-3 rounded-xl bg-warn-bg px-3 py-2.5 text-[12px] leading-relaxed text-warn-ink">
                    {row.error}
                  </p>
                ) : null}
              </div>
            ))}
          </div>

          {error ? (
            <p className="mt-4 rounded-xl bg-warn-bg px-3.5 py-3 text-[13px] leading-relaxed text-warn-ink">
              {error}
            </p>
          ) : null}

          <button
            type="button"
            onClick={payAll}
            disabled={isRunning || payable === 0}
            className={`mt-4 ${PRIMARY}`}
          >
            {isRunning ? "Confirm each payment…" : `Pay all ${payable}`}
          </button>

          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            Three separate transactions, one wallet confirmation each — not a batch and not a
            contract. That is what keeps each invoice separately provable.
          </p>
        </>
      )}

      <footer className="mt-8 text-center text-[11px] leading-relaxed text-muted">
        Tempo Moderato testnet · not financial advice · World's Fair build
      </footer>
    </main>
  );
}

function RowPill({ status }: { status: RowStatus }) {
  const label =
    status === "sent"
      ? "Paid"
      : status === "sending"
        ? "Sending"
        : status === "failed"
          ? "Failed"
          : "Unpaid";

  const tone =
    status === "sent"
      ? "bg-ok text-ink"
      : status === "failed"
        ? "bg-warn-bg text-warn-ink"
        : "border border-line bg-canvas text-muted";

  return (
    <span
      className={`rounded-md px-2.5 py-1 text-[10px] font-semibold tracking-[0.14em] uppercase ${tone} ${
        status === "sending" ? "pulse" : ""
      }`}
    >
      {label}
    </span>
  );
}
