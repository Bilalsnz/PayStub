import type { EIP1193Provider } from "viem";
import { createConfig, http, injected } from "wagmi";

import {
  TEMPO_ADD_CHAIN_PARAMS,
  TEMPO_CHAIN_HEX,
  tempoMainnet,
  tempoTestnet,
} from "./chains";

export type WalletId = "okx" | "metamask" | "rabby";

export const WALLET_LABEL: Record<WalletId, string> = {
  okx: "OKX Wallet",
  metamask: "MetaMask",
  rabby: "Rabby",
};

/**
 * One connector per wallet, each pointed at its own provider object rather than
 * at "whatever happens to be at window.ethereum" — otherwise three wallets
 * installed side by side fight over the same object and the buttons all open
 * the same one.
 */
type InjectedEthereum = EIP1193Provider & {
  isMetaMask?: boolean;
  isRabby?: boolean;
  isOkxWallet?: boolean;
};

type InjectedWindow = {
  okxwallet?: EIP1193Provider;
  ethereum?: InjectedEthereum;
};

function readWindow(): InjectedWindow {
  if (typeof window === "undefined") return {};
  return window as unknown as InjectedWindow;
}

function okxProvider(): EIP1193Provider | undefined {
  const w = readWindow();
  if (w.okxwallet) return w.okxwallet;
  return w.ethereum?.isOkxWallet ? w.ethereum : undefined;
}

function metaMaskProvider(): EIP1193Provider | undefined {
  const eth = readWindow().ethereum;
  // Rabby advertises isMetaMask for dapp compatibility, so exclude it here or
  // the MetaMask button connects to Rabby.
  return eth?.isMetaMask && !eth.isRabby ? eth : undefined;
}

function rabbyProvider(): EIP1193Provider | undefined {
  const eth = readWindow().ethereum;
  return eth?.isRabby ? eth : undefined;
}

/** Which of the three this browser actually has. Client-only. */
export function walletInstalled(id: WalletId): boolean {
  if (id === "okx") return Boolean(okxProvider());
  if (id === "metamask") return Boolean(metaMaskProvider());
  return Boolean(rabbyProvider());
}

/**
 * Mobile Chrome is not a wallet, so an OKX tap there has to leave the browser.
 * The `okx://` scheme only opens when it is wrapped in OKX's own redirect page,
 * which is what makes a phone pop the app instead of doing nothing.
 */
export function okxDeepLink(url: string): string {
  return `https://web3.okx.com/download?deeplink=${encodeURIComponent(
    `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(url)}`,
  )}`;
}

type RequestProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function asRequestProvider(value: unknown): RequestProvider | undefined {
  const candidate = value as { request?: unknown } | null | undefined;
  return candidate && typeof candidate.request === "function"
    ? (candidate as RequestProvider)
    : undefined;
}

/** Whatever wallet this browser has, when no specific connector is in play. */
export function getInjectedProvider(): RequestProvider | undefined {
  const w = readWindow();
  return asRequestProvider(w.okxwallet) ?? asRequestProvider(w.ethereum);
}

/** The EIP-1193 provider behind a wagmi connector, if it can produce one. */
export async function providerFor(
  connector: { getProvider: (parameters?: { chainId?: number }) => Promise<unknown> } | undefined,
): Promise<unknown> {
  if (!connector) return undefined;
  try {
    return await connector.getProvider();
  } catch {
    return undefined;
  }
}

export function errorMessage(error: unknown): string {
  if (!error) return "";
  const e = error as { shortMessage?: string; message?: string; cause?: unknown };
  const cause = e.cause as { shortMessage?: string; message?: string } | undefined;
  return e.shortMessage ?? cause?.shortMessage ?? e.message ?? cause?.message ?? String(error);
}

export function errorCode(error: unknown): number | undefined {
  const e = error as { code?: number; cause?: { code?: number } } | undefined;
  return e?.code ?? e?.cause?.code;
}

export function isUserRejection(error: unknown): boolean {
  if (errorCode(error) === 4001) return true;
  return /user (rejected|denied|cancell?ed)|rejected the request/i.test(errorMessage(error));
}

/**
 * OKX mobile sometimes parks `wallet_switchEthereumChain` behind a phishing
 * wall. That is a wallet screen, not a crash — say what to do and let them pay.
 */
export const SWITCH_HELP =
  "Open this site in MetaMask browser, or tap Continue anyway in OKX. Then pay.";

/**
 * Runs before every payment. Connects nothing, signs nothing — it only makes
 * sure the wallet is looking at Tempo, adding the chain if it has never seen it
 * (wallet error 4902).
 *
 * 42431 in hex is 0xa5bf. That lives in lib/chains.ts; nothing here spells it
 * out again, so there is exactly one place for it to be wrong.
 */
export async function ensureTempoChain(provider?: unknown): Promise<void> {
  const active = asRequestProvider(provider) ?? asRequestProvider(getInjectedProvider());
  if (!active) {
    throw new Error("No wallet in this browser. Connect one first.");
  }

  const current = await active.request({ method: "eth_chainId" });
  if (typeof current === "string" && current.toLowerCase() === TEMPO_CHAIN_HEX) return;

  try {
    await active.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: TEMPO_CHAIN_HEX }],
    });
  } catch (error) {
    if (errorCode(error) !== 4902) throw error;

    await active.request({
      method: "wallet_addEthereumChain",
      params: [TEMPO_ADD_CHAIN_PARAMS],
    });

    // Some wallets switch on add, some only add. Ask once more, quietly.
    try {
      await active.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: TEMPO_CHAIN_HEX }],
      });
    } catch {
      /* verified below */
    }
  }

  const after = await active.request({ method: "eth_chainId" });
  if (typeof after !== "string" || after.toLowerCase() !== TEMPO_CHAIN_HEX) {
    throw new Error(SWITCH_HELP);
  }
}

/**
 * `injected` is imported from `wagmi` — i.e. `@wagmi/core` — and deliberately
 * NOT from `wagmi/connectors`. That subpath re-exports every connector wagmi
 * ships, including Base Account, which pulls `@base-org/account` →
 * `@coinbase/cdp-sdk` → the optional peer `@x402/evm` that npm does not
 * install, so importing the barrel fails the build on a module this app never
 * calls. `@wagmi/core`'s own injected connector reaches for nothing but viem,
 * and EIP-6963 discovery still arrives through `mipd`.
 */
export const wagmiConfig = createConfig({
  chains: [tempoTestnet, tempoMainnet],
  connectors: [
    injected({
      shimDisconnect: true,
      target: { id: "okx", name: WALLET_LABEL.okx, provider: okxProvider },
    }),
    injected({
      shimDisconnect: true,
      target: { id: "metamask", name: WALLET_LABEL.metamask, provider: metaMaskProvider },
    }),
    injected({
      shimDisconnect: true,
      target: { id: "rabby", name: WALLET_LABEL.rabby, provider: rabbyProvider },
    }),
  ],
  transports: {
    [tempoTestnet.id]: http(tempoTestnet.rpcUrls.default.http[0]),
    [tempoMainnet.id]: http(tempoMainnet.rpcUrls.default.http[0]),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
