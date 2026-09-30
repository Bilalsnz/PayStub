"use client";

import { useEffect, useMemo, useState } from "react";
import { createPublicClient, decodeEventLog, encodeEventTopics, http, type Log } from "viem";

import { PATHUSD_ABI } from "@/lib/abi";
import { tempoTestnet } from "@/lib/chains";
import { copyText, formatTime, shortAddress } from "@/lib/format";
import {
  PATHUSD_ADDRESS,
  PATHUSD_LABEL,
  TEMPO_FEE_ADDRESS,
  explorerTxUrl,
  formatAmount,
  isTxHash,
  memoIsTruncated,
  unpackMemo,
} from "@/lib/pathusd";

const SECONDARY =
  "mt-3 w-full rounded-2xl border border-line bg-card px-4 py-3.5 text-[15px] font-semibold text-ink";
const LINK_BUTTON =
  "mt-3 block w-full rounded-2xl bg-accent px-4 py-4 text-center text-[16px] font-semibold text-white";

/**
 * Topic0 identifies the two pathUSD events without decoding anything, which is
 * what the raw-log fallback below relies on. Verified against live Tempo logs:
 * TransferWithMemo carries the memo as an indexed topic[3].
 */
const TRANSFER_TOPIC = encodeEventTopics({ abi: PATHUSD_ABI, eventName: "Transfer" })[0];
const TRANSFER_WITH_MEMO_TOPIC = encodeEventTopics({
  abi: PATHUSD_ABI,
  eventName: "TransferWithMemo",
})[0];

type Payment = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  memo: `0x${string}` | null;
};

type View =
  | { kind: "loading" }
  | { kind: "confirming"; elapsed: number }
  | {
      kind: "done";
      status: "success" | "reverted";
      payment: Payment | null;
      timestamp: bigint | null;
    }
  | { kind: "notfound" }
  | { kind: "offline" };

function isNotFoundError(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name ?? "";
  if (/NotFound/i.test(name)) return true;
  const message = (error as { message?: string } | undefined)?.message ?? "";
  return /(transaction|receipt).{0,40}(not be found|could not be found|not found)/i.test(message);
}

function stripMemo(memo: string): `0x${string}` | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(memo)) return null;
  return /^0x0+$/.test(memo) ? null : (memo.toLowerCase() as `0x${string}`);
}

type Candidate = Payment & { withMemo: boolean };

/** Decodes one pathUSD log, or null if it is not a transfer we care about. */
function readLog(log: Log): Candidate | null {
  if (log.address.toLowerCase() !== PATHUSD_ADDRESS.toLowerCase()) return null;

  const topics = log.topics as readonly string[];

  try {
    const decoded = decodeEventLog({
      abi: PATHUSD_ABI,
      data: log.data,
      topics: log.topics,
    }) as unknown as { eventName: string; args: Record<string, unknown> };

    if (decoded.eventName === "TransferWithMemo") {
      return {
        from: decoded.args.from as `0x${string}`,
        to: decoded.args.to as `0x${string}`,
        value: decoded.args.value as bigint,
        memo: stripMemo(decoded.args.memo as string),
        withMemo: true,
      };
    }

    if (decoded.eventName === "Transfer") {
      return {
        from: decoded.args.from as `0x${string}`,
        to: decoded.args.to as `0x${string}`,
        value: decoded.args.value as bigint,
        memo: null,
        withMemo: false,
      };
    }

    return null;
  } catch {
    // Raw-log fallback: topic0, two indexed addresses, the value in the data,
    // and for TransferWithMemo the memo in topic[3].
    const isMemoTransfer = topics[0] === TRANSFER_WITH_MEMO_TOPIC && topics.length >= 4;
    const isTransfer = topics[0] === TRANSFER_TOPIC && topics.length >= 3;
    if ((!isMemoTransfer && !isTransfer) || log.data.length < 66) return null;

    try {
      return {
        from: `0x${topics[1].slice(26)}` as `0x${string}`,
        to: `0x${topics[2].slice(26)}` as `0x${string}`,
        value: BigInt(log.data.slice(0, 66)),
        memo: isMemoTransfer ? stripMemo(topics[3]) : null,
        withMemo: isMemoTransfer,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Reads exactly ONE transfer out of the transaction — never a sum.
 *
 * Two traps, both confirmed against live testnet transactions:
 *
 * 1. pathUSD emits BOTH `Transfer` and `TransferWithMemo` for a single
 *    `transferWithMemo` call, with the same value. Summing them doubled every
 *    receipt — a 600 payment read back as 1200.
 * 2. Tempo pays gas in TIP-20, so the same transaction also carries a small
 *    pathUSD transfer from the payer to the fee collector. That is not the
 *    payment either, so "the first Transfer from the payer" is unsafe.
 *
 * `TransferWithMemo` is the unambiguous one — the fee transfer never carries a
 * memo. The payee comes from that event's own `to`; `tx.to` is always the
 * pathUSD contract, because that is the contract that was called.
 */
function extractPayment(logs: readonly Log[], payer: string): Payment | null {
  const payerLower = payer.toLowerCase();

  const candidates = logs
    .map(readLog)
    .filter((candidate): candidate is Candidate => candidate !== null)
    .filter((candidate) => candidate.to.toLowerCase() !== TEMPO_FEE_ADDRESS.toLowerCase())
    .filter((candidate) => candidate.to.toLowerCase() !== PATHUSD_ADDRESS.toLowerCase());

  if (candidates.length === 0) return null;

  const fromPayer = candidates.filter((candidate) => candidate.from.toLowerCase() === payerLower);
  const pool = fromPayer.length > 0 ? fromPayer : candidates;
  const chosen = pool.find((candidate) => candidate.withMemo) ?? pool[0];

  return {
    from: chosen.from,
    to: chosen.to,
    value: chosen.value,
    memo: chosen.memo,
  };
}

export function ReceiptView({ txHash, urlNote }: { txHash: string; urlNote: string }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  const client = useMemo(
    () =>
      createPublicClient({
        chain: tempoTestnet,
        transport: http(tempoTestnet.rpcUrls.default.http[0], { timeout: 20_000 }),
      }),
    [],
  );

  const wellFormed = isTxHash(txHash);
  const hash = txHash as `0x${string}`;

  useEffect(() => {
    if (!wellFormed) {
      setView({ kind: "notfound" });
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    let failures = 0;

    async function poll() {
      polls += 1;
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        const [transaction, block] = await Promise.all([
          client.getTransaction({ hash }),
          client.getBlock({ blockNumber: receipt.blockNumber }),
        ]);

        if (cancelled) return;
        failures = 0;

        setView({
          kind: "done",
          status: receipt.status === "success" ? "success" : "reverted",
          payment: extractPayment(receipt.logs, transaction.from),
          timestamp: block?.timestamp ?? null,
        });
      } catch (error) {
        if (cancelled) return;

        if (isNotFoundError(error)) {
          // Two seconds apart, and after half a minute a wrong link is the
          // more likely explanation than a slow block.
          if (polls >= 15) {
            setView({ kind: "notfound" });
            return;
          }
          setView({ kind: "confirming", elapsed: polls * 2 });
          timer = setTimeout(poll, 2000);
          return;
        }

        failures += 1;
        if (failures >= 3) {
          setView({ kind: "offline" });
          return;
        }
        timer = setTimeout(poll, 2000);
      }
    }

    setView({ kind: "loading" });
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [attempt, client, hash, wellFormed]);

  return (
    <main className="mx-auto w-full max-w-[430px] px-4 pt-7 pb-14">
      <header className="flex items-center justify-between">
        <a href="/" className="text-[15px] font-semibold tracking-tight">
          PayStub
        </a>
        <span className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
          Tempo Testnet
        </span>
      </header>

      {view.kind === "loading" ? (
        <div className="mt-6 rounded-[20px] border border-line bg-card p-6">
          <div className="h-4 w-24 rounded bg-canvas" />
          <div className="pulse mt-4 h-14 w-48 rounded bg-canvas" />
          <div className="mt-5 h-4 w-full rounded bg-canvas" />
          <div className="mt-2 h-4 w-2/3 rounded bg-canvas" />
        </div>
      ) : null}

      {view.kind === "confirming" ? (
        <div className="fade-in mt-6 rounded-[20px] border border-line bg-card p-6">
          <div className="pulse text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
            Confirming on Tempo…
          </div>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            The payment is in flight. This page updates on its own — {view.elapsed}s.
          </p>
          <a
            className={LINK_BUTTON}
            href={explorerTxUrl(txHash)}
            target="_blank"
            rel="noreferrer"
          >
            Open explorer
          </a>
        </div>
      ) : null}

      {view.kind === "notfound" ? (
        <div className="fade-in mt-6 rounded-[20px] border border-line bg-card p-6">
          <h1 className="text-[24px] font-semibold tracking-tight">Receipt not found.</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-muted">
            Nothing on Tempo matches this link. Check the address, or keep checking if the payment
            was sent seconds ago.
          </p>
          <button type="button" className={SECONDARY} onClick={() => setAttempt((n) => n + 1)}>
            Keep checking
          </button>
          {wellFormed ? (
            <a className={LINK_BUTTON} href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer">
              Open explorer
            </a>
          ) : null}
        </div>
      ) : null}

      {view.kind === "offline" ? (
        <div className="fade-in mt-6 rounded-[20px] border border-line bg-card p-6">
          <h1 className="text-[24px] font-semibold tracking-tight">Could not reach Tempo.</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-muted">
            Check your connection and pull it again. The payment itself is unaffected.
          </p>
          <button type="button" className={SECONDARY} onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : null}

      {view.kind === "done" && view.status === "reverted" ? (
        <div className="fade-in mt-6 rounded-[20px] border border-line bg-card p-6">
          <div className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
            Receipt
          </div>
          <div className="mt-2 text-[44px] leading-none font-semibold tracking-tight text-ink">
            FAILED
          </div>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            This transaction reverted on Tempo. No pathUSD moved, so there is nothing to receipt.
          </p>
          <Row label="Transaction" value={shortAddress(txHash, 6)} mono />
          <a className={LINK_BUTTON} href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer">
            Open explorer
          </a>
        </div>
      ) : null}

      {view.kind === "done" && view.status === "success" && !view.payment ? (
        <div className="fade-in mt-6 rounded-[20px] border border-line bg-card p-6">
          <div className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
            Receipt
          </div>
          <div className="mt-2 text-[32px] leading-tight font-semibold tracking-tight">
            No pathUSD transfer in this transaction.
          </div>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            The transaction is on Tempo and it succeeded, but no pathUSD moved, so it is not a
            PayStub receipt.
          </p>
          <a className={LINK_BUTTON} href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer">
            Open explorer
          </a>
        </div>
      ) : null}

      {view.kind === "done" && view.status === "success" && view.payment ? (
        <PaidCard
          payment={view.payment}
          timestamp={view.timestamp}
          txHash={txHash}
          urlNote={urlNote}
        />
      ) : null}

      <footer className="mt-8 text-center text-[12px] leading-relaxed text-muted">
        Not a bank. Onchain receipt on Tempo. Colosseum World's Fair.
      </footer>
    </main>
  );
}

function PaidCard({
  payment,
  timestamp,
  txHash,
  urlNote,
}: {
  payment: Payment;
  timestamp: bigint | null;
  txHash: string;
  urlNote: string;
}) {
  const [copied, setCopied] = useState(false);

  const fullNote = urlNote.trim();
  const memoNote = payment.memo ? unpackMemo(payment.memo) : "";
  const shownNote = fullNote || memoNote;
  const shortened = !fullNote && Boolean(payment.memo) && memoIsTruncated(payment.memo as string);

  async function handleCopy() {
    const ok = await copyText(window.location.href);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fade-in mt-6 rounded-[20px] border border-line bg-card p-6">
      <div className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
        Receipt
      </div>

      <div className="mt-2 text-[60px] leading-[0.95] font-semibold tracking-tight text-accent">
        PAID
      </div>

      <div className="mt-6 text-[30px] font-semibold tracking-tight tabular-nums">
        {formatAmount(payment.value)}
      </div>
      <div className="text-[13px] text-muted">{PATHUSD_LABEL}</div>

      {shownNote ? (
        <div className="mt-5 rounded-[14px] bg-canvas px-4 py-3.5">
          <div className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
            Note
          </div>
          <p className="mt-1 text-[16px] leading-snug">{shownNote}</p>
          {shortened ? (
            <p className="mt-1.5 text-[11px] text-muted">Shortened to fit the onchain memo.</p>
          ) : null}
        </div>
      ) : null}

      <dl className="mt-6 space-y-3 border-t border-line pt-5">
        <Row label="Payer" value={shortAddress(payment.from, 6)} mono />
        <Row label="Payee" value={shortAddress(payment.to, 6)} mono />
        <Row label="Time" value={formatTime(timestamp)} />
        <Row label="Transaction" value={shortAddress(txHash, 6)} mono />
      </dl>

      <button type="button" className={SECONDARY} onClick={handleCopy}>
        {copied ? "Link copied" : "Copy link"}
      </button>
      <a className={LINK_BUTTON} href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer">
        Open explorer
      </a>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd className={`text-right ${mono ? "font-mono text-[13px]" : "text-[14px]"}`}>{value}</dd>
    </div>
  );
}
