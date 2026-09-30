import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";

import { tempoMainnet, tempoTestnet } from "./chains";

/**
 * One injected connector. `multiInjectedProviderDiscovery` is on by default in
 * wagmi v2, so OKX Wallet and MetaMask each show up on their own when the
 * browser announces them (EIP-6963).
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
