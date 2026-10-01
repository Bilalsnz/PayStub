"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useReadContract } from "wagmi";

import { PATHUSD_ABI } from "@/lib/abi";
import { tempoTestnet } from "@/lib/chains";
import { copyText, shortAddress } from "@/lib/format";
import {
  createInvoice,
  getInvoice,
  listInvoices,
  markPaid,
  parseInvoiceInput,
  seedDemoInvoices,
  shareUrl,
  type Invoice,
} from "@/lib/invoices";
import {
  NOTE_MAX,
  PATHUSD_ADDRESS,
  PATHUSD_LABEL,
  faucet,
  findInvoicePayment,
  formatAmount,
  parseAmount,
} from "@/lib/pathusd";
import {
  SWITCH_HELP,
  WALLET_LABEL,
  ensureTempoChain,
  errorMessage,
  isUserRejection,
  okxDeepLink,
  providerFor,
  walletInstalled,
  type WalletId,
} from "@/lib/wagmi";

const CARD = "rounded-2xl border border-line bg-card p-5";
const INPUT =
  "mt-1.5 w-full rounded-xl border border-line bg-canvas px-3.5 py-3 leading-snug tracking-tight text-ink outline-none placeholder:text-muted/50 focus:border-accent";
const PRIMARY =
  "w-full rounded-2xl bg-accent px-4 py-4 text-[16px] font-semibold text-white disabled:opacity-40";
const SECONDARY =
  "w-full rounded-2xl border border-line bg-card px-4 py-3.5 text-[15px] font-semibold text-ink";

const STEPS = ["Create", "Send link", "Paid on Tempo"] as const;
const WALLET_ORDER: WalletId[] = ["okx", "metamask", "rabby"];
const WALLET_HINT: Record<WalletId, { here: string; away: string }> = {
  okx: { here: "Pay from the OKX app", away: "Opens OKX on this phone" },
  metamask: { here: "Pay from MetaMask", away: "Not in this browser" },
  rabby: { here: "Pay from Rabby", away: "Not in this browser" },
};
const DUE_OPTIONS = ["Today", "This week"] as const;

export default function HomePage() {
  const router = useRouter();
  const createRef = useRef<HTMLDivElement | null>(null);

  const [mounted, setMounted] = useState(false);
  const [installed, setInstalled] = useState<Record<WalletId, boolean>>({
    okx: false,
    metamask: false,
    rabby: false,
  });
  const [book, setBook] = useState<Invoice[]>([]);

  const { address, chainId, isConnected, connector } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnect } = useDisconnect();

  const [amount, setAmount] = useState("");
  const [jobNote, setJobNote] = useState("");
  const [due, setDue] = useState<string>("");
  const [created, setCreated] = useState<Invoice | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [openInput, setOpenInput] = useState("");
  const [showOpen, setShowOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [walletHint, setWalletHint] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<WalletId | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetNote, setFaucetNote] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    setInstalled({
      okx: walletInstalled("okx"),
      metamask: walletInstalled("metamask"),
      rabby: walletInstalled("rabby"),
    });
    setBook(listInvoices());
  }, []);

  /**
   * The stored status is a cache. This re-asks the chain whenever the screen
   * comes back into view, so paying an invoice on its own page and pressing
   * back shows PAID here — without a refresh button and without a server.
   */
  useEffect(() => {
    if (!mounted) return;

    let cancelled = false;

    async function refresh() {
      const pending = listInvoices()
        .filter((invoice) => invoice.status !== "paid")
        .slice(0, 3);

      for (const invoice of pending) {
        try {
          const since = Math.floor(new Date(invoice.createdAt).getTime() / 1000);
          const payment = await findInvoicePayment({
            invoiceId: invoice.id,
            payee: invoice.payee,
            since,
          });
          if (cancelled) return;
          if (payment) markPaid(invoice.id, payment.txHash);
        } catch {
          /* keep the cached status and move on to the next one */
        }
      }

      if (!cancelled) setBook(listInvoices());
    }

    refresh();

    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [mounted]);

  const wrongNetwork = mounted && isConnected && chainId !== tempoTestnet.id;

  const {
    data: balance,
    isFetching: balanceFetching,
    refetch: refetchBalance,
  } = useReadContract({
    address: PATHUSD_ADDRESS,
    abi: PATHUSD_ABI,
    functionName: "balanceOf",
    args: address ? ([address] as const) : undefined,
    chainId: tempoTestnet.id,
    query: { enabled: Boolean(address), refetchInterval: 8000 },
  });

  async function handleWallet(id: WalletId) {
    setFormError(null);
    setWalletHint(null);

    if (mounted && !installed[id]) {
      if (id === "okx") {
        window.location.href = okxDeepLink(window.location.href);
        return;
      }
      setWalletHint(`${WALLET_LABEL[id]} is not in this browser. Open this page inside it.`);
      return;
    }

    const found = connectors.find((candidate) => candidate.id === id);
    if (!found) {
      setWalletHint(`${WALLET_LABEL[id]} is not in this browser. Open this page inside it.`);
      return;
    }

    setConnectingId(id);
    try {
      await connectAsync({ connector: found });
    } catch (error) {
      if (!isUserRejection(error)) {
        setWalletHint(
          /provider|not found|no provider/i.test(errorMessage(error))
            ? `${WALLET_LABEL[id]} is not in this browser. Open this page inside it.`
            : errorMessage(error) || `Could not connect ${WALLET_LABEL[id]}.`,
        );
      }
    } finally {
      setConnectingId(null);
    }
  }

  async function handleSwitch() {
    setFormError(null);
    setIsSwitching(true);
    try {
      await ensureTempoChain(await providerFor(connector));
    } catch (error) {
      if (!isUserRejection(error)) {
        setFormError(errorMessage(error) || SWITCH_HELP);
      }
    } finally {
      setIsSwitching(false);
    }
  }

  async function handleFaucet() {
    if (!address) return;
    setFormError(null);
    setFaucetNote(null);
    setFaucetBusy(true);

    const result = await faucet(address);
    if (!result.ok) {
      setFaucetBusy(false);
      setFormError(result.detail);
      return;
    }

    let landed = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const refreshed = await refetchBalance();
      if (typeof refreshed.data === "bigint" && refreshed.data > 0n) {
        landed = true;
        break;
      }
    }

    setFaucetBusy(false);
    setFaucetNote(
      landed
        ? "Test USD is in your wallet."
        : "Sent. The balance can take a moment — it refreshes on its own.",
    );
  }

  function handleCreate() {
    setFormError(null);

    if (!address) {
      setFormError("Connect a wallet first — that is the address you get paid at.");
      return;
    }

    let value: bigint;
    try {
      value = parseAmount(amount);
    } catch (error) {
      setFormError(errorMessage(error));
      return;
    }

    const trimmed = jobNote.trim();
    if (!trimmed) {
      setFormError("Say what the job was, so the client knows what they paid for.");
      return;
    }

    const invoice = createInvoice({
      payee: address,
      amount: formatAmount(value),
      note: trimmed,
      due,
    });

    setBook(listInvoices());
    setCreated(invoice);
    setAmount("");
    setJobNote("");
    setDue("");
  }

  async function copyInvoice(invoice: Invoice) {
    const ok = await copyText(shareUrl(invoice, window.location.origin));
    if (!ok) return;
    setCopiedId(invoice.id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  function handleOpen() {
    setFormError(null);
    const id = parseInvoiceInput(openInput);
    if (!id) {
      setFormError("That does not look like an invoice. Paste a link or an INV-0841 id.");
      return;
    }
    const local = getInvoice(id);
    router.push(local ? shareUrl(local, "") : `/i/${id}`);
  }

  function handleSeed() {
    if (!address) return;
    setBook(seedDemoInvoices(address));
    setCreated(null);
  }

  return (
    <main className="mx-auto w-full max-w-[430px] px-4 pb-16">
      <header className="flex items-baseline justify-between pt-6">
        <span className="text-[16px] font-semibold tracking-tight text-ink">PayStub</span>
        <span className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
          Tempo Moderato
        </span>
      </header>

      <h1 className="mt-8 text-[38px] leading-[1.04] font-semibold tracking-tight text-ink">
        Invoice a job.
        <br />
        Get paid in USD.
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">
        Create an invoice. Send the link. When pathUSD lands on Tempo, it flips to PAID.
      </p>

      <div className="mt-6 grid grid-cols-3 gap-2">
        {STEPS.map((step, index) => (
          <div key={step} className="rounded-xl border border-line bg-card px-3 py-3">
            <div className="text-[13px] font-semibold tracking-tight text-accent tabular-nums">
              {index + 1}
            </div>
            <div className="mt-1 text-[12px] leading-snug text-muted">{step}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        <button
          type="button"
          className={PRIMARY}
          onClick={() => createRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
        >
          Create invoice
        </button>
        <button type="button" className={SECONDARY} onClick={() => setShowOpen((v) => !v)}>
          Open an invoice
        </button>
      </div>

      {showOpen ? (
        <div className={`mt-2 ${CARD}`}>
          <Field label="Invoice id or link">
            <input
              className={INPUT}
              value={openInput}
              onChange={(event) => setOpenInput(event.target.value)}
              placeholder="INV-0841"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </Field>
          <button type="button" className={`mt-3 ${SECONDARY}`} onClick={handleOpen}>
            Open
          </button>
        </div>
      ) : null}

      <div ref={createRef} className={`mt-4 scroll-mt-4 ${CARD}`}>
        <SectionLabel n="01">Create</SectionLabel>

        {!mounted ? (
          <div className="mt-4 space-y-2">
            <div className="h-[62px] w-full rounded-2xl bg-canvas" />
            <div className="h-[62px] w-full rounded-2xl bg-canvas" />
          </div>
        ) : !isConnected ? (
          <>
            <p className="mt-3 text-[13px] leading-relaxed text-muted">
              Connect the wallet you want to be paid at.
            </p>
            <div className="mt-3 space-y-2">
              {WALLET_ORDER.map((id) => (
                <WalletButton
                  key={id}
                  label={WALLET_LABEL[id]}
                  hint={installed[id] ? WALLET_HINT[id].here : WALLET_HINT[id].away}
                  busy={connectingId === id}
                  onClick={() => handleWallet(id)}
                />
              ))}
            </div>
            {walletHint ? <p className="mt-3 text-[12px] text-muted">{walletHint}</p> : null}
          </>
        ) : (
          <>
            <div className="mt-3 flex items-center justify-between rounded-xl bg-canvas px-3.5 py-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
                  You are paid at
                </div>
                <div className="mt-0.5 font-mono text-[14px]">{shortAddress(address, 6)}</div>
              </div>
              <button
                type="button"
                onClick={() => disconnect()}
                className="shrink-0 pl-3 text-[12px] font-semibold text-accent underline"
              >
                Disconnect
              </button>
            </div>

            <Field label="Amount in USD">
              <input
                className={INPUT}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="40.00"
                inputMode="decimal"
                autoComplete="off"
              />
              <span className="mt-1.5 block text-[12px] text-muted">{PATHUSD_LABEL}</span>
            </Field>

            <Field label="What the job was">
              <input
                className={INPUT}
                value={jobNote}
                onChange={(event) => setJobNote(event.target.value)}
                placeholder="Logo for flyer"
                maxLength={NOTE_MAX}
                autoComplete="off"
              />
              <span className="mt-1.5 flex items-baseline justify-between text-[12px] text-muted">
                <span>Rides onchain in the payment memo.</span>
                <span className="tabular-nums">
                  {jobNote.length}/{NOTE_MAX}
                </span>
              </span>
            </Field>

            <div className="mt-4">
              <span className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
                Due
              </span>
              <div className="mt-1.5 flex gap-2">
                {DUE_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setDue(due === option ? "" : option)}
                    className={`rounded-xl border px-3.5 py-2 text-[13px] font-semibold ${
                      due === option
                        ? "border-accent bg-accent text-white"
                        : "border-line bg-canvas text-muted"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>

            {wrongNetwork ? (
              <>
                <button
                  type="button"
                  onClick={handleSwitch}
                  disabled={isSwitching}
                  className="mt-4 w-full rounded-2xl bg-warn-bg px-4 py-4 text-[16px] font-semibold text-warn-ink disabled:opacity-60"
                >
                  {isSwitching ? "Switching…" : "Switch to Tempo Testnet"}
                </button>
                <p className="mt-2 text-[12px] leading-relaxed text-muted">
                  Invoices are payable on Tempo Moderato. Your wallet is on another chain.
                </p>
              </>
            ) : null}

            <button type="button" onClick={handleCreate} className={`mt-4 ${PRIMARY}`}>
              Create invoice
            </button>

            <div className="mt-4 flex items-center justify-between rounded-xl bg-canvas px-3.5 py-3">
              <div>
                <div className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
                  Balance
                </div>
                <div className="mt-0.5 text-[15px] font-semibold tabular-nums">
                  {typeof balance === "bigint"
                    ? `${formatAmount(balance)} pathUSD`
                    : balanceFetching
                      ? "Checking…"
                      : "—"}
                </div>
              </div>

              {balance === 0n && !faucetBusy ? (
                <button
                  type="button"
                  onClick={handleFaucet}
                  className="shrink-0 rounded-xl border border-line bg-card px-3.5 py-2 text-[13px] font-semibold text-accent"
                >
                  Get test USD
                </button>
              ) : null}

              {faucetBusy ? (
                <span className="pulse shrink-0 text-[12px] text-muted">Sending…</span>
              ) : null}
            </div>

            {faucetNote ? <p className="mt-2 text-[12px] text-muted">{faucetNote}</p> : null}

            <button type="button" onClick={handleSeed} className={`mt-3 ${SECONDARY}`}>
              Load demo invoices
            </button>
          </>
        )}

        {formError ? (
          <p className="mt-3 rounded-xl bg-warn-bg px-3.5 py-3 text-[13px] leading-relaxed text-warn-ink">
            {formError}
          </p>
        ) : null}
      </div>

      {created ? (
        <div className={`fade-in mt-4 ${CARD}`}>
          <div className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
            Invoice created
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-[20px] font-semibold tracking-tight">{created.id}</span>
            <span className="text-[20px] font-semibold tabular-nums">{created.amount}</span>
          </div>
          <p className="mt-1 text-[13px] text-muted">{created.note}</p>
          <button type="button" className={`mt-4 ${PRIMARY}`} onClick={() => copyInvoice(created)}>
            {copiedId === created.id ? "Link copied" : "Copy share link"}
          </button>
          <button
            type="button"
            className={`mt-2 ${SECONDARY}`}
            onClick={() => router.push(shareUrl(created, ""))}
          >
            Open invoice
          </button>
        </div>
      ) : null}

      <div className={`mt-4 ${CARD}`}>
        <SectionLabel n="02">Your book</SectionLabel>

        {book.length === 0 ? (
          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            Nothing yet. Create an invoice, or load the demo triad.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {book.map((invoice) => (
              <li key={invoice.id}>
                <button
                  type="button"
                  onClick={() => router.push(shareUrl(invoice, ""))}
                  className="flex w-full items-center justify-between gap-3 py-3 text-left"
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-[14px] font-semibold">{invoice.id}</span>
                    <span className="mt-0.5 block truncate text-[12px] text-muted">
                      {invoice.note}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-[15px] font-semibold tabular-nums">
                      {invoice.amount}
                    </span>
                    <span
                      className={`mt-0.5 inline-block rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-[0.1em] uppercase ${
                        invoice.status === "paid"
                          ? "bg-ok text-ink"
                          : "border border-line bg-canvas text-muted"
                      }`}
                    >
                      {invoice.status}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          className={`mt-4 ${SECONDARY}`}
          onClick={() => router.push("/payout")}
        >
          Payout run →
        </button>
      </div>

      <footer className="mt-8 text-center text-[11px] leading-relaxed text-muted">
        Tempo Moderato testnet · not financial advice · World's Fair build
      </footer>
    </main>
  );
}

function SectionLabel({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[13px] font-semibold tracking-tight text-accent tabular-nums">{n}</span>
      <span className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
        {children}
      </span>
    </div>
  );
}

function WalletButton({
  label,
  hint,
  busy,
  onClick,
}: {
  label: string;
  hint: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-center justify-between rounded-2xl border border-line bg-card px-4 py-3.5 text-left disabled:opacity-60"
    >
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold tracking-tight text-ink">{label}</span>
        <span className="mt-0.5 block text-[12px] text-muted">{hint}</span>
      </span>
      <span className="shrink-0 pl-3 text-[13px] font-semibold text-accent">
        {busy ? "Opening…" : "Connect"}
      </span>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mt-4 block">
      <span className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}
