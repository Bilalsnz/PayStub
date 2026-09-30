"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useWriteContract,
} from "wagmi";

import { PATHUSD_ABI } from "@/lib/abi";
import { TEMPO_ADD_CHAIN_PARAMS, TEMPO_CHAIN_HEX, tempoTestnet } from "@/lib/chains";
import { shortAddress } from "@/lib/format";
import {
  NOTE_MAX,
  PATHUSD_ADDRESS,
  PATHUSD_LABEL,
  faucet,
  formatAmount,
  packMemo,
  parseAddress,
  parseAmount,
} from "@/lib/pathusd";
import { WALLET_LABEL, type WalletId, okxDeepLink, walletInstalled } from "@/lib/wagmi";

const INPUT =
  "mt-1.5 w-full rounded-xl border border-line bg-canvas px-3.5 py-3 leading-snug tracking-tight text-ink outline-none placeholder:text-muted/50 focus:border-accent";
const PRIMARY =
  "w-full rounded-2xl bg-accent px-4 py-4 text-[16px] font-semibold text-white disabled:opacity-40";

const WALLET_ORDER: WalletId[] = ["okx", "metamask", "rabby"];

const WALLET_HINT: Record<WalletId, { here: string; away: string }> = {
  okx: { here: "Pay from the OKX app", away: "Opens OKX on this phone" },
  metamask: { here: "Pay from MetaMask", away: "Not in this browser" },
  rabby: { here: "Pay from Rabby", away: "Not in this browser" },
};

type WalletProvider = {
  request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function getInjectedProvider(): WalletProvider | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { okxwallet?: WalletProvider; ethereum?: WalletProvider };
  if (w.okxwallet?.request) return w.okxwallet;
  if (w.ethereum?.request) return w.ethereum;
  return undefined;
}

function errorMessage(error: unknown): string {
  if (!error) return "";
  const e = error as { shortMessage?: string; message?: string; cause?: unknown };
  const cause = e.cause as { shortMessage?: string; message?: string } | undefined;
  return e.shortMessage ?? cause?.shortMessage ?? e.message ?? cause?.message ?? String(error);
}

function errorCode(error: unknown): number | undefined {
  const e = error as { code?: number; cause?: { code?: number } } | undefined;
  return e?.code ?? e?.cause?.code;
}

function isUserRejection(error: unknown): boolean {
  if (errorCode(error) === 4001) return true;
  return /user (rejected|denied|cancell?ed)|rejected the request/i.test(errorMessage(error));
}

/**
 * Runs before every write. Connects nothing, signs nothing — it only makes
 * sure the wallet is looking at Tempo Testnet, adding the chain if the wallet
 * has never seen it (error 4902).
 */
async function ensureTempoChain(): Promise<void> {
  const provider = getInjectedProvider();
  if (!provider?.request) {
    throw new Error("No wallet in this browser. Connect one first.");
  }

  const current = await provider.request({ method: "eth_chainId" });
  if (typeof current === "string" && current.toLowerCase() === TEMPO_CHAIN_HEX) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: TEMPO_CHAIN_HEX }],
    });
  } catch (error) {
    if (errorCode(error) !== 4902) throw error;

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [TEMPO_ADD_CHAIN_PARAMS],
    });

    // Some wallets switch on add, some only add. Ask once more, quietly.
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: TEMPO_CHAIN_HEX }],
      });
    } catch {
      /* verified below */
    }
  }

  const after = await provider.request({ method: "eth_chainId" });
  if (typeof after !== "string" || after.toLowerCase() !== TEMPO_CHAIN_HEX) {
    throw new Error("Your wallet is still not on Tempo Testnet. Switch, then try again.");
  }
}

export default function HomePage() {
  const router = useRouter();

  const [mounted, setMounted] = useState(false);
  const [installed, setInstalled] = useState<Record<WalletId, boolean>>({
    okx: false,
    metamask: false,
    rabby: false,
  });

  useEffect(() => {
    setMounted(true);
    setInstalled({
      okx: walletInstalled("okx"),
      metamask: walletInstalled("metamask"),
      rabby: walletInstalled("rabby"),
    });
  }, []);

  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContractAsync } = useWriteContract();

  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [walletHint, setWalletHint] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<WalletId | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetNote, setFaucetNote] = useState<string | null>(null);

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

  /**
   * Connects to one specific wallet. If that wallet is not in this browser the
   * button does something useful rather than nothing: OKX hands off to the OKX
   * app, the other two say so plainly.
   */
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

    const connector = connectors.find((candidate) => candidate.id === id);
    if (!connector) {
      setWalletHint(`${WALLET_LABEL[id]} is not in this browser. Open this page inside it.`);
      return;
    }

    setConnectingId(id);
    try {
      await connectAsync({ connector });
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
      await ensureTempoChain();
    } catch (error) {
      if (!isUserRejection(error)) setFormError(errorMessage(error));
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

  async function handlePay() {
    setFormError(null);

    let to: `0x${string}`;
    let value: bigint;
    try {
      to = parseAddress(payee);
      value = parseAmount(amount);
    } catch (error) {
      setFormError(errorMessage(error));
      return;
    }

    if (!isConnected) {
      setFormError("Pick a wallet above first.");
      return;
    }

    setIsPaying(true);
    try {
      await ensureTempoChain();

      const trimmed = note.trim();

      // transferWithMemo carries the job note. Only if it genuinely fails does
      // the payment fall back to a plain transfer — never both, or the receipt
      // would carry two transfers for one job.
      let hash: `0x${string}`;
      try {
        hash = await writeContractAsync({
          address: PATHUSD_ADDRESS,
          abi: PATHUSD_ABI,
          functionName: "transferWithMemo",
          args: [to, value, packMemo(trimmed)],
          chainId: tempoTestnet.id,
        });
      } catch (error) {
        if (isUserRejection(error)) throw error;
        hash = await writeContractAsync({
          address: PATHUSD_ADDRESS,
          abi: PATHUSD_ABI,
          functionName: "transfer",
          args: [to, value],
          chainId: tempoTestnet.id,
        });
      }

      const query = trimmed ? `?note=${encodeURIComponent(trimmed)}` : "";
      router.push(`/r/${hash}${query}`);
    } catch (error) {
      if (!isUserRejection(error)) {
        setFormError(errorMessage(error) || "The payment did not go through.");
      }
      setIsPaying(false);
    }
  }

  const canPay =
    mounted &&
    isConnected &&
    !wrongNetwork &&
    payee.trim().length > 0 &&
    amount.trim().length > 0 &&
    !isPaying;

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="bg-accent">
        <div className="mx-auto flex w-full max-w-[430px] items-center justify-between px-4 py-4">
          <span className="text-[15px] font-semibold tracking-tight text-white">PayStub</span>
          <span className="text-[10px] font-semibold tracking-[0.16em] text-white/75 uppercase">
            Tempo Testnet
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[430px] px-4 pb-14">
        <h1 className="mt-7 text-[34px] leading-[1.08] font-semibold tracking-tight text-ink">
          Get a receipt both sides can trust.
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          Pay a job in USD on Tempo. Both of you open the same page: paid, amount, note, proof.
        </p>

        <section className="mt-6 rounded-[20px] border border-line bg-card p-5">
          <StepLabel n="01">Amount</StepLabel>

          <Field label="Payee address">
            <input
              className={INPUT}
              value={payee}
              onChange={(event) => setPayee(event.target.value)}
              placeholder="0x…"
              inputMode="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </Field>

          <Field label="Amount">
            <input
              className={INPUT}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="5.00"
              inputMode="decimal"
              autoComplete="off"
            />
            <span className="mt-1.5 block text-[12px] text-muted">{PATHUSD_LABEL}</span>
          </Field>

          <Field label="Job note">
            <textarea
              className={`${INPUT} resize-none`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Logo for flyer"
              rows={2}
              maxLength={NOTE_MAX}
            />
            <span className="mt-1.5 flex items-baseline justify-between text-[12px] text-muted">
              <span>Rides onchain in the payment memo.</span>
              <span className="tabular-nums">
                {note.length}/{NOTE_MAX}
              </span>
            </span>
          </Field>
        </section>

        <section className="mt-4 rounded-[20px] border border-line bg-card p-5">
          <StepLabel n="02">Pay</StepLabel>

          {!mounted ? (
            <div className="mt-4 space-y-2">
              <div className="h-[62px] w-full rounded-2xl bg-canvas" />
              <div className="h-[62px] w-full rounded-2xl bg-canvas" />
              <div className="h-[62px] w-full rounded-2xl bg-canvas" />
            </div>
          ) : !isConnected ? (
            <div className="mt-4 space-y-2">
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
          ) : (
            <>
              <div className="mt-4 flex items-center justify-between rounded-xl bg-canvas px-3.5 py-3">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
                    Paying from
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

              <div className="mt-3 flex items-center justify-between rounded-xl bg-canvas px-3.5 py-3">
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
                    Payments only go out on Tempo Testnet. Your wallet is on another chain right
                    now.
                  </p>
                </>
              ) : null}

              <button
                type="button"
                onClick={handlePay}
                disabled={!canPay}
                className={`mt-4 ${PRIMARY}`}
              >
                {isPaying ? "Check your wallet…" : "Pay and issue receipt"}
              </button>
            </>
          )}

          {walletHint ? <p className="mt-3 text-[12px] text-muted">{walletHint}</p> : null}

          {formError ? (
            <p className="mt-3 rounded-xl bg-warn-bg px-3.5 py-3 text-[13px] leading-relaxed text-warn-ink">
              {formError}
            </p>
          ) : null}

          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            New Vercel apps get a MetaMask malicious warning — tick Acknowledge then Confirm.
          </p>
        </section>

        <section className="mt-4 rounded-[20px] border border-line bg-card p-5">
          <StepLabel n="03">Receipt</StepLabel>
          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            The moment the payment lands you get a public page with the proof on it. Send that link
            to the worker. No account, nothing to install.
          </p>

          <div className="mt-4 rounded-2xl border border-dashed border-line bg-canvas p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
                Preview layout only
              </span>
              <span className="font-mono text-[10px] text-muted">/r/…</span>
            </div>

            <div className="mt-3 text-[40px] leading-none font-semibold tracking-tight text-accent/35">
              PAID
            </div>
            <div className="mt-3 text-[20px] font-semibold tracking-tight text-muted tabular-nums">
              —.— pathUSD
            </div>

            <dl className="mt-4 space-y-2 text-[13px] text-muted">
              {["Note", "Payer", "Payee", "Time"].map((label) => (
                <div key={label} className="flex items-baseline justify-between gap-4">
                  <dt>{label}</dt>
                  <dd>—</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <footer className="mt-8 text-center text-[12px] leading-relaxed text-muted">
          Not a bank. Onchain receipt on Tempo. Colosseum World's Fair.
        </footer>
      </main>
    </div>
  );
}

function StepLabel({ n, children }: { n: string; children: React.ReactNode }) {
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
