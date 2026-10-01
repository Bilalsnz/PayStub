import {
  createPublicClient,
  formatUnits,
  getAddress,
  hexToBytes,
  http,
  isAddress,
  parseUnits,
  type Log,
  type PublicClient,
} from "viem";

import { TEMPO_EXPLORER_URL, TEMPO_RPC_URL, tempoTestnet } from "./chains";

export const PATHUSD_ADDRESS =
  "0x20c0000000000000000000000000000000000000" as const;

export const PATHUSD_DECIMALS = 6;

/**
 * Tempo pays gas in TIP-20 stablecoins, so a pathUSD payment transaction also
 * contains a small pathUSD transfer from the payer to this fee collector.
 * Verified on live testnet transactions — it must never be read as the payment.
 */
export const TEMPO_FEE_ADDRESS = "0xfeec000000000000000000000000000000000000";

/** What the user sees next to every amount. */
export const PATHUSD_LABEL = "pathUSD (test USD)";

/** Notes longer than this are truncated into the bytes32 memo. */
export const NOTE_MAX = 80;

export function explorerTxUrl(hash: string): string {
  return `${TEMPO_EXPLORER_URL}/tx/${hash}`;
}

export function isTxHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * "5" or "5.00" or "1,250.5" -> 5000000n.
 * The user types human USD; the chain gets 6-decimal units.
 */
export function parseAmount(input: string): bigint {
  const cleaned = input.trim().replace(/,/g, "").replace(/\s/g, "");
  if (cleaned === "" || !/\d/.test(cleaned)) {
    throw new Error("Enter an amount, like 5 or 5.00.");
  }
  if (!/^\d*\.?\d*$/.test(cleaned)) {
    throw new Error("Amount must be a number, like 5 or 5.00.");
  }

  const [, fraction = ""] = cleaned.split(".");
  if (fraction.length > PATHUSD_DECIMALS) {
    throw new Error(`Use at most ${PATHUSD_DECIMALS} decimal places.`);
  }

  const value = parseUnits(cleaned, PATHUSD_DECIMALS);
  if (value <= 0n) throw new Error("Amount must be greater than 0.");
  return value;
}

/**
 * 600000000n -> "600.00": exactly `formatUnits(value, 6)` to two places, with
 * no thousands separator, so what the explorer calls 600 the card calls 600.00.
 * Never goes through a float.
 */
export function formatAmount(value: bigint): string {
  const raw = formatUnits(value, PATHUSD_DECIMALS);
  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = body.split(".");
  const cents = (fraction + "00").slice(0, 2);
  return `${negative ? "-" : ""}${whole}.${cents}`;
}

export function parseAddress(input: string): `0x${string}` {
  const trimmed = input.trim();
  if (!isAddress(trimmed)) {
    throw new Error("That does not look like a wallet address (0x + 40 characters).");
  }
  return getAddress(trimmed);
}

/**
 * bytes32 memo = first 32 UTF-8 bytes of the note, right-padded with zeros.
 * The full sentence also travels on the receipt URL, so a truncated memo never
 * costs the reader the note.
 */
export function packMemo(note: string): `0x${string}` {
  const bytes = new TextEncoder().encode(note);
  const out = new Uint8Array(32);
  out.set(bytes.slice(0, 32));
  let hex = "0x";
  for (const byte of out) hex += byte.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}

function memoBytes(memo: string): Uint8Array {
  try {
    const bytes = hexToBytes(memo as `0x${string}`);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    return bytes.slice(0, end);
  } catch {
    return new Uint8Array(0);
  }
}

/** Reads a bytes32 memo back into text. Invalid bytes degrade to U+FFFD. */
export function unpackMemo(memo: string): string {
  try {
    return new TextDecoder().decode(memoBytes(memo));
  } catch {
    return "";
  }
}

/** True when the memo filled all 32 bytes, i.e. the note was cut short. */
export function memoIsTruncated(memo: string): boolean {
  return memoBytes(memo).length === 32;
}

export type FaucetResult = { ok: true; hashes: string[] } | { ok: false; detail: string };

/**
 * Test USD for the connected address, straight from the testnet RPC.
 *
 * The faucet is a plain JSON-RPC method, not a contract call:
 *   {"jsonrpc":"2.0","method":"tempo_fundAddress","params":["0x…"],"id":1}
 * It answers with the hashes of the transfers it made.
 */
export async function faucet(address: string): Promise<FaucetResult> {
  try {
    const res = await fetch(TEMPO_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tempo_fundAddress",
        params: [address],
        id: 1,
      }),
    });

    if (!res.ok) {
      return { ok: false, detail: `The faucet answered HTTP ${res.status}. Try again in a moment.` };
    }

    const json = (await res.json()) as {
      result?: unknown;
      error?: { message?: string; code?: number };
    };

    if (json.error) {
      return { ok: false, detail: json.error.message ?? "The faucet declined this request." };
    }

    const hashes = Array.isArray(json.result)
      ? json.result.filter((item): item is string => typeof item === "string")
      : [];

    return { ok: true, hashes };
  } catch {
    return {
      ok: false,
      detail:
        "Could not reach the faucet from this browser. The curl command in the README does the same thing.",
    };
  }
}

/* ─────────────────────────── invoice matching ─────────────────────────── */

/**
 * Topic0 of `TransferWithMemo`, measured against live Moderato logs.
 *
 * The memo is an INDEXED topic on that event (topic[3]), and that single fact
 * is the whole product: it lets the node answer "has INV-0841 been paid to this
 * address?" as a log query. No indexer, no database, no server of ours.
 */
export const TRANSFER_WITH_MEMO_TOPIC: `0x${string}` =
  "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";

/** The node rejects any eth_getLogs wider than 100,000 blocks. Measured, not guessed. */
export const MAX_LOG_RANGE = 100_000;

/** Measured on Moderato: 10,000 blocks took 5.98 seconds. */
export const TEMPO_BLOCK_SECONDS = 0.598;

/** How far back an invoice with no known creation time is willing to walk. */
const CHUNK = 50_000n;
const MAX_CHUNKS = 6;

let cachedClient: PublicClient | null = null;

function rpcClient(): PublicClient {
  if (!cachedClient) {
    cachedClient = createPublicClient({
      chain: tempoTestnet,
      transport: http(TEMPO_RPC_URL, { timeout: 20_000 }),
    });
  }
  return cachedClient;
}

export type InvoicePayment = {
  txHash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  /** The invoice id decoded back out of the memo. */
  invoiceId: string;
  blockNumber: bigint;
};

function decodeInvoiceLog(log: Log): InvoicePayment | null {
  const topics = log.topics as readonly string[];
  if (topics.length < 4) return null;

  let value: bigint;
  try {
    value = BigInt(log.data);
  } catch {
    return null;
  }

  return {
    txHash: log.transactionHash as `0x${string}`,
    from: `0x${topics[1].slice(26)}` as `0x${string}`,
    to: `0x${topics[2].slice(26)}` as `0x${string}`,
    value,
    invoiceId: unpackMemo(topics[3]),
    blockNumber: log.blockNumber as bigint,
  };
}

/**
 * Finds the payment for one invoice by asking the chain, not a database.
 *
 * The query is exact, and it is exact because the memo is indexed:
 *   topic0 = TransferWithMemo, topic[2] = payee, topic[3] = INV-xxxx in bytes32
 *
 * Two things this deliberately cannot get wrong, both of which bit the earlier
 * receipt page: a plain `Transfer` can never match a topic0 of
 * `TransferWithMemo`, so the *second* event a `transferWithMemo` call emits is
 * never double-counted; and Tempo's TIP-20 gas fee is a plain `Transfer` to the
 * fee collector, so it can never be mistaken for the payment either.
 *
 * Walks newest-first and stops at the first hit. A fresh invoice is one call;
 * an older one steps backwards a chunk at a time.
 */
export async function findInvoicePayment({
  invoiceId,
  payee,
  since,
}: {
  invoiceId: string;
  /** Unix seconds the invoice was created. Bounds the walk. */
  since?: number;
}): Promise<InvoicePayment | null> {
  if (!isAddress(payee)) return null;

  const client = rpcClient();
  const memo = packMemo(invoiceId);
  const toTopic = `0x${"0".repeat(24)}${getAddress(payee).slice(2).toLowerCase()}` as `0x${string}`;

  const topics = [TRANSFER_WITH_MEMO_TOPIC, null, toTopic, memo] as [
    `0x${string}`,
    null,
    `0x${string}`,
    `0x${string}`,
  ];

  const head = await client.getBlockNumber();

  // A day is ~144k blocks at 0.598s, so a fresh invoice needs one chunk and an
  // old one walks the whole budget. Clock skew between two phones is real, so
  // pad the window generously rather than trimming it.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageSeconds = since && since > 0 ? Math.max(0, nowSeconds - since) : Number.POSITIVE_INFINITY;
  const budget = CHUNK * BigInt(MAX_CHUNKS);
  const wanted = Number.isFinite(ageSeconds)
    ? BigInt(Math.ceil(ageSeconds / TEMPO_BLOCK_SECONDS) + 5_000)
    : budget;
  const reach = wanted > budget ? budget : wanted;
  const stopAt = head > reach ? head - reach : 0n;

  let top = head;
  for (let step = 0; step <= MAX_CHUNKS; step += 1) {
    const raw = top > CHUNK ? top - CHUNK : 0n;
    const bottom = raw < stopAt ? stopAt : raw;

    const logs = await client.getLogs({
      address: PATHUSD_ADDRESS,
      topics,
      fromBlock: bottom,
      toBlock: top,
    });

    const first = logs[0];
    if (first) return decodeInvoiceLog(first);

    if (bottom <= stopAt || bottom === 0n) return null;
    top = bottom - 1n;
  }

  return null;
}

/** Block timestamp for the paid line, in the same bigint shape formatTime wants. */
export async function blockTimestamp(blockNumber: bigint): Promise<bigint | null> {
  try {
    const block = await rpcClient().getBlock({ blockNumber });
    return block?.timestamp ?? null;
  } catch {
    return null;
  }
}

/**
 * Waits for the payment to land: one-second polls, 30-second ceiling. Blocks
 * here are 0.598s, so a payment is normally visible on the first poll.
 */
export async function waitForPayment(hash: `0x${string}`): Promise<boolean> {
  const receipt = await rpcClient().waitForTransactionReceipt({
    hash,
    pollingInterval: 1_000,
    timeout: 30_000,
    confirmations: 1,
  });
  return receipt.status === "success";
}
