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

const INPUT =
  "mt-1.5 w-full rounded-xl border border-line bg-card px-3.5 py-3 leading-snug tracking-tight text-ink outline-none placeholder:text-muted/50 focus:border-accent";
const PRIMARY =
  "w-full rounded-2xl bg-accent px-4 py-4 text-[16px] font-semibold text-white disabled:opacity-40";

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
    throw new Error("Open this site inside OKX Wallet or MetaMask in-app browser.");
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
  const [hasProvider, setHasProvider] = useState(false);

  useEffect(() => {
    setMounted(true);
    setHasProvider(Boolean(getInjectedProvider()));
  }, []);

  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContractAsync } = useWriteContract();

  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
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

  async function handleConnect() {
    setFormError(null);
    if (!getInjectedProvider()) {
      setFormError("Open this site inside OKX Wallet or MetaMask in-app browser.");
      return;
    }
    try {
      const preferred =
        connectors.find((connector) => /okx/i.test(connector.name)) ??
        connectors.find((connector) => connector.id === "injected") ??
        connectors[0];

      if (!preferred) {
        setFormError("Open this site inside OKX Wallet or MetaMask in-app browser.");
        return;
      }
      await connectAsync({ connector: preferred });
    } catch (error) {
      if (isUserRejection(error)) return;
      setFormError(errorMessage(error) || "Could not connect the wallet.");
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
      await handleConnect();
      return;
    }

    setIsPaying(true);
    try {
      await ensureTempoChain();

      const trimmed = note.trim();
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
        // The memo is a nicety. If this build of pathUSD will not take it, the
        // job still has to get paid — plain transfer, same receipt hash.
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
    !isPaying &&
    !isConnecting;

  return (
    <main className="mx-auto w-full max-w-[430px] px-4 pt-7 pb-14">
      <header className="flex items-center justify-between">
        <span className="text-[15px] font-semibold tracking-tight">PayStub</span>
        <span className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
          Tempo Testnet
        </span>
      </header>

      <h1 className="mt-8 text-[30px] leading-[1.15] font-semibold tracking-tight">
        Get a receipt both sides can trust.
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">
        Pay a job in USD on Tempo. Both of you open the same page: paid, amount, note, proof.
      </p>

      <section className="mt-7 rounded-[20px] border border-line bg-card p-5">
        <StepLabel>01 Amount</StepLabel>

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
        <StepLabel>02 Pay</StepLabel>

        {!mounted ? (
          <div className="mt-4 h-[54px] w-full rounded-2xl bg-canvas" />
        ) : !hasProvider ? (
          <p className="mt-4 rounded-xl bg-canvas px-3.5 py-3 text-[14px] leading-relaxed">
            Open this site inside OKX Wallet or MetaMask in-app browser.
          </p>
        ) : !isConnected ? (
          <>
            <button
              type="button"
              onClick={handleConnect}
              disabled={isConnecting}
              className={`mt-4 ${PRIMARY} disabled:opacity-100`}
            >
              {isConnecting ? "Connecting…" : "Connect wallet"}
            </button>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              Your address is used for one thing: sending this payment.
            </p>
          </>
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
                className="shrink-0 pl-3 text-[12px] font-semibold text-muted underline"
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
                  className="shrink-0 rounded-full border border-line bg-card px-3.5 py-2 text-[13px] font-semibold"
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
                  Payments only go out on Tempo Testnet. Your wallet is on another chain right now.
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

        {formError ? (
          <p className="mt-3 rounded-xl bg-warn-bg px-3.5 py-3 text-[13px] leading-relaxed text-warn-ink">
            {formError}
          </p>
        ) : null}
      </section>

      <section className="mt-4 rounded-[20px] border border-line bg-card p-5">
        <StepLabel>03 Receipt</StepLabel>
        <p className="mt-3 text-[13px] leading-relaxed text-muted">
          The moment the payment lands you get a public page with the proof on it. Send that link to
          the worker. No account, nothing to install.
        </p>

        <div className="mt-4 rounded-[16px] border border-dashed border-line p-4">
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
  );
}

function StepLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
      {children}
    </div>
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
