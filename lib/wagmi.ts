import { createConfig, http, injected } from "wagmi";

import { tempoMainnet, tempoTestnet } from "./chains";

/**
 * One injected connector. `multiInjectedProviderDiscovery` is on by default in
 * wagmi v2 (via `mipd`), so OKX Wallet and MetaMask each show up on their own
 * when the browser announces them (EIP-6963).
 *
 * `injected` is imported from `wagmi` — i.e. `@wagmi/core` — and deliberately
 * NOT from `wagmi/connectors`. That subpath re-exports every connector wagmi
 * ships, including Base Account, which pulls `@base-org/account` →
 * `@coinbase/cdp-sdk` → the optional peer `@x402/evm` that npm does not
 * install. Importing the barrel therefore fails the build on a module this app
 * never calls. `@wagmi/core`'s own injected connector is 24 KB and reaches for
 * nothing but viem, and EIP-6963 discovery still arrives through `mipd`.
 */
export const wagmiConfig = createConfig({
  chains: [tempoTestnet, tempoMainnet],
  connectors: [injected({ shimDisconnect: true })],
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
