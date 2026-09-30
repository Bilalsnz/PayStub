import { defineChain } from "viem";

/**
 * Tempo. Gas on Tempo is paid in TIP-20 stablecoins, not ETH — so nothing in
 * this app ever sends `msg.value`, and no code path waits on an ETH balance.
 *
 * Testnet first, always. Mainnet is defined only as a fallback target.
 */
export const tempoTestnet = defineChain({
  id: 42431,
  name: "Tempo Testnet (Moderato)",
  nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.moderato.tempo.xyz"] },
  },
  blockExplorers: {
    default: { name: "Tempo Explorer", url: "https://explore.testnet.tempo.xyz" },
  },
  testnet: true,
});

export const tempoMainnet = defineChain({
  id: 4217,
  name: "Tempo",
  nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.tempo.xyz"] },
  },
  blockExplorers: {
    default: { name: "Tempo Explorer", url: "https://explore.tempo.xyz" },
  },
});

/** The chain every write in this app targets. */
export const ACTIVE_CHAIN = tempoTestnet;

/** 42431 in hex, as wallets want it. */
export const TEMPO_CHAIN_HEX = "0xa5bf";

/** Exact payload for `wallet_addEthereumChain` (used on error code 4902). */
export const TEMPO_ADD_CHAIN_PARAMS = {
  chainId: TEMPO_CHAIN_HEX,
  chainName: "Tempo Testnet (Moderato)",
  rpcUrls: ["https://rpc.moderato.tempo.xyz"],
  nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 },
  blockExplorerUrls: ["https://explore.testnet.tempo.xyz"],
} as const;

export const TEMPO_RPC_URL = tempoTestnet.rpcUrls.default.http[0];
export const TEMPO_EXPLORER_URL = tempoTestnet.blockExplorers.default.url;
