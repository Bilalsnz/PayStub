# PayStub

**Create an invoice. Client pays pathUSD on Tempo. The invoice flips to PAID.**

The invoice *is* the receipt. No account, no backend, no database, no contract.

> **No custom contract.** There is no `PayStub.sol`, no bytecode, no ABI in this repo other than
> `pathUSD`'s own. A payment is a `transferWithMemo` on `pathUSD`, and the invoice id rides in the
> memo. Matching is the product.

Colosseum Crypto World's Fair — category: **Payment and remittance**. Chain: **Tempo Moderato**.

---

## What to commit and deploy

Nothing to configure — no env vars, no keys, no database.

```bash
git add -A && git commit -m "PayStub: invoice desk" && git push
```

Vercel is already wired to this repo; pushing `main` redeploys. Then hard-refresh the deployment.

---

## 45-second demo

Wallet funded first: the **Get test USD** button appears on home when the balance is `0`.

| Time | Do | Say |
| ---- | -- | --- |
| 0:00 | Home screen | "Invoice a job, get paid in USD." |
| 0:05 | Tap **Load demo invoices** | "Three unpaid invoices, instantly." |
| 0:10 | Open **INV-0841** | "$40, Logo for flyer. UNPAID." |
| 0:16 | Tap **Pay this invoice**, confirm in the wallet | "The amount and the memo are already filled. I only confirm." |
| 0:26 | Page flips to **PAID** by itself | "Nobody told it. It asked the chain." |
| 0:32 | Tap **Open explorer** | "There is the invoice id, inside the TIP-20 memo." |
| 0:38 | **Copy receipt link**, open it in a plain browser | "No wallet, no account — same proof. That's the product." |

**Payout run** (`/payout`) is the client side: three contractors, three `transferWithMemo` calls sent
one after another — not a batch, so each invoice keeps its own hash.

---

## Tempo Moderato

| Field | Value |
| ----- | ----- |
| Network | Tempo Moderato Testnet |
| Chain ID | `42431` (`0xa5bf`) |
| RPC | `https://rpc.moderato.tempo.xyz` |
| Explorer | `https://explore.testnet.tempo.xyz` |
| Token | pathUSD `0x20c0000000000000000000000000000000000000`, 6 decimals |
| Pay call | `transferWithMemo(address to, uint256 amount, bytes32 memo)` |
| Faucet | `tempo_fundAddress` on the RPC (the **Get test USD** button) |

Gas on Tempo is paid in TIP-20 stablecoins, not ETH. Nothing here sends `msg.value`, and the Pay
button is disabled on any chain other than `42431`.

---

## How matching works

`TransferWithMemo` indexes the memo, so the chain can answer the question directly:

```
eth_getLogs  topic0 = TransferWithMemo
             topic[2] = payee address
             topic[3] = "INV-0841" as bytes32
```

One call. That is the whole index — no server of ours is in the loop, and `/i/[id]` runs it straight
from the browser. Two failure modes this design cannot have, both of which bit an earlier build of
this app:

- A `transferWithMemo` call emits **both** a `Transfer` and a `TransferWithMemo` with the same
  value. Filtering on topic0 means the duplicate can never be double-counted.
- Tempo pays gas in TIP-20, so each payment carries a small extra pathUSD transfer to the fee
  collector `0xfeec…`. A plain `Transfer` can never match a `TransferWithMemo` filter, so the fee
  can never be mistaken for the payment.

The invoice page reads the payee from the event's own `to`. The explorer's top-level "To" is always
the pathUSD contract, because that is what was called — correct, and not the payee.

---

## Layout

```
app/
  page.tsx                    home: create an invoice, your book, demo seed
  i/[id]/page.tsx             invoice route (server shell)
  i/[id]/invoice-view.tsx     scans the chain, renders UNPAID / PAID
  payout/page.tsx             client-side payout run, 3 sequential payments
  r/[txHash]/                 standalone chain receipt, if you have a bare hash
lib/
  invoices.ts                 localStorage book, share links, demo seed
  pathusd.ts                  token, memo pack/unpack, findInvoicePayment()
  wagmi.ts                    three injected connectors, chain switch, errors
  chains.ts / abi.ts / format.ts
```

Tempo Moderato testnet · not financial advice · World's Fair build
