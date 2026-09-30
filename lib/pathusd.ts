import { formatUnits, getAddress, hexToBytes, isAddress, parseUnits } from "viem";

import { TEMPO_EXPLORER_URL, TEMPO_RPC_URL } from "./chains";

export const PATHUSD_ADDRESS =
  "0x20c0000000000000000000000000000000000000" as const;

export const PATHUSD_DECIMALS = 6;

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

/** 5000000n -> "5.00". Never goes through a float. */
export function formatAmount(value: bigint): string {
  const raw = formatUnits(value, PATHUSD_DECIMALS);
  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = body.split(".");
  const cents = (fraction + "00").slice(0, 2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${cents}`;
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
