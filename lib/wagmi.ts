import type { EIP1193Provider } from "viem";
import { createConfig, http, injected } from "wagmi";

import { tempoMainnet, tempoTestnet } from "./chains";

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
