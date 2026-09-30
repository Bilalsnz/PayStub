# PayStub

**A receipt both sides can trust.**

A client pays a worker in USD on Tempo for a named job. Both sides open the same public page and
see PAID, the amount, the note, who paid whom, the time, and a link to the transaction on the
explorer. That page is the product.

"I sent it" on WhatsApp is not proof. PayStub makes a cross-border job payment checkable in one tap.

> **No custom contract.** PayStub deploys no Solidity and owns no contract address. Receipts are
> plain `pathUSD` transfers — the transaction hash *is* the receipt id. The job note rides along in
> the `memo` field of `transferWithMemo`.

Built for **Colosseum Crypto World's Fair** — category: **Payment and remittance**. Chain: **Tempo**.

---

## 1. Run it, then ship it

```bash
npm i
npm run dev        # http://localhost:3000
```

Deploy:

```bash
npx vercel         # or: vercel --prod
```

Or with no terminal at all: push the repo to GitHub and import it at
[vercel.com/new](https://vercel.com/new). Next.js is detected automatically.

**There are no environment variables and no secrets.** Nothing is configured, nothing is billed,
nothing needs a key. The RPC and the faucet are public.

---

## 2. Add Tempo Testnet to OKX Wallet / MetaMask

Networks on Tempo are identified by chain ID. If the wallet has never seen Tempo, PayStub adds it
for you — the **Switch to Tempo Testnet** button sends `wallet_switchEthereumChain`, and on wallet
error `4902` it follows up with `wallet_addEthereumChain` using exactly these values.

| Field           | Value                              |
| --------------- | ---------------------------------- |
| Network name    | Tempo Testnet (Moderato)           |
| Chain ID        | `42431`                            |
| Hex chain ID    | `0xa5bf`                           |
| RPC URL         | `https://rpc.moderato.tempo.xyz`    |
| Block explorer  | `https://explore.testnet.tempo.xyz` |
| Currency symbol | `USD`                              |
| Decimals        | `18` (wallet metadata only)        |

Mainnet, as a fallback only if the testnet RPC is ever down:

| Field          | Value                     |
| -------------- | ------------------------- |
| Chain ID       | `4217`                    |
| RPC URL        | `https://rpc.tempo.xyz`   |
| Block explorer | `https://explore.tempo.xyz` |

To add it by hand in MetaMask: **Settings → Networks → Add a network → Add a network manually**,
then paste the values above.

Two things that are *not* true on Tempo and will confuse you if you assume them:

- **Gas is paid in TIP-20 stablecoins, not ETH.** PayStub never sends `msg.value` and never waits
  on an ETH balance. Your wallet may still *display* an ETH balance as `0` — that is not a problem.
- **Tempo is not Ethereum mainnet.** PayStub disables the Pay button whenever the wallet is on any
  chain other than `42431`. A transaction cannot leave on chain 1 from this app.

### Tokens

`pathUSD` is the default and the only one PayStub uses, on both testnet and mainnet:

```
pathUSD   0x20c0000000000000000000000000000000000000   (6 decimals)
```

These also exist, but the app does not default to them: AlphaUSD `0x20c0…0001`, BetaUSD `0x20c0…0002`,
ThetaUSD `0x20c0…0003`.

---

## 3. Faucet — get test USD

The faucet is a plain JSON-RPC method on the testnet node, not a contract call. The **Get test USD**
button (it appears when your balance is `0`) posts exactly this and then refetches `balanceOf`:

```bash
curl -s -X POST https://rpc.moderato.tempo.xyz \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tempo_fundAddress","params":["YOUR_ADDRESS_HERE"],"id":1}'
```

It answers with the hashes of the transfers it made:

```json
{"jsonrpc":"2.0","id":1,"result":["0xd703f345…","0x8ecd97ac…","0x3c22a904…","0xc76322e3…","0xfcbad581…"]}
```

If the button ever fails inside a wallet browser (some in-app browsers block cross-origin
requests), that curl does the same thing — run it from any terminal and refresh the balance.

---

## 4. Demo script for a judge

Two minutes, one phone, no slides.

1. **Open the site in the OKX Wallet in-app browser** (or MetaMask's). If you open it in a normal
   browser with no wallet, PayStub says so instead of failing: *"Open this site inside OKX Wallet or
   MetaMask in-app browser."*
2. **Tap Connect wallet.** If the wallet has never seen Tempo, tap **Switch to Tempo Testnet** and
   approve the add-network prompt. This is the only setup step, and it happens once.
3. **Tap Get test USD.** The balance goes from `0.00` to a funded balance in a few seconds.
4. **Fill in 01 Amount** — a second address you control, amount `1`, note `Logo for flyer`.
5. **Tap Pay and issue receipt.** The wallet asks to confirm one pathUSD transfer. The note is
   already inside it as the memo.
6. **Land on the receipt.** Giant **PAID**, `1.00 pathUSD (test USD)`, the note, payer, payee, time,
   and **Open explorer**.
7. **Tap Copy link and open that link in a second browser** — a normal browser, no wallet, no
   account, nothing installed. Same receipt, same proof. *That* is the demo: the worker does not
   need a wallet to check that they were paid.
8. **Tap Open explorer** to land on `https://explore.testnet.tempo.xyz/tx/0x…`.

To repeat: the faucet drips on demand, and a fresh address works every time.

---

## 5. No custom contract — receipts are pathUSD transfers

This is a deliberate constraint, not a shortcut.

- There is **no `PayStub.sol`**, no compiled bytecode, no deployed address, and no ABI in this repo
  other than `pathUSD`'s own (`lib/abi.ts`).
- A receipt is a `pathUSD` transfer on Tempo. **The transaction hash is the receipt id**, and
  `/r/<txHash>` reads it back from the chain with `getTransaction` and `getTransactionReceipt`.
- The job note is packed into a `bytes32` memo — the first 32 UTF-8 bytes, right-padded with zeros —
  and passed to `transferWithMemo(to, amount, memo)`. The full sentence is also carried on the
  receipt URL as `?note=…`, so an 80-character note is never lost to the memo's 32-byte limit.
- If a build of `pathUSD` refuses `transferWithMemo`, PayStub immediately falls back to
  `transfer(to, amount)` and still issues the receipt from that hash. The payment always wins over
  the memo.

Nothing in this repo can move funds except a transfer the user explicitly confirms in their own
wallet.

---

## How a receipt is verified

`/r/<txHash>` builds a viem public client on `https://rpc.moderato.tempo.xyz` and:

1. Calls `getTransactionReceipt`. If the receipt is not there yet, it shows **"Confirming on
   Tempo…"** and polls every 2 seconds. Nothing is ever rendered as PAID before the chain says so.
2. If the receipt says `reverted`, the page shows **FAILED** — no pathUSD moved, so there is nothing
   to receipt.
3. Otherwise it decodes the `Transfer` / `TransferWithMemo` logs from `pathUSD`, takes the transfer
   the payer actually sent, sums it, and reads the memo back into text.
4. If the transaction is real but contains no pathUSD transfer, the page says so plainly instead of
   dressing it up as a payment.
5. If the hash is malformed, or half a minute passes with nothing found, it shows **"Receipt not
   found."** with a keep-checking button and a link to the explorer.

The chain is the only source of truth here. Nothing is cached, and no server of ours is in the loop.

---

## Verified against the live testnet

These were confirmed by calling `https://rpc.moderato.tempo.xyz` directly, not assumed from docs.
They are the assumptions PayStub would break on, so they were checked first.

| Check | Method | Result |
| ----- | ------ | ------ |
| Chain ID | `eth_chainId` | `0xa5bf` (= 42431) |
| Token symbol | `symbol()` on `0x20c0…0000` | `pathUSD` |
| Token decimals | `decimals()` on `0x20c0…0000` | `6` |
| Faucet | `tempo_fundAddress` | returns 5 transfer hashes |
| `transferWithMemo` exists | `eth_call`, selector `0x95777d59` | executes the real TIP-20 balance check |
| `TransferWithMemo` event | `eth_getLogs`, topic0 `0x57bc7354…` | 80 live logs in a 3,000-block window |
| Memo layout | decoded those logs | `from` topic[1], `to` topic[2], `memo` topic[3], value in data |
| Browser access | CORS preflight + POST from a foreign origin | `access-control-allow-origin: *`, POST allowed |
| Explorer link | `GET /tx/<hash>` | HTTP 200 |

The two that matter most:

**The memo mechanism is real and in use.** `TransferWithMemo(address,address,uint256,bytes32)` has
selector `0x95777d59` and topic0 `0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0`.
Calling it with an amount larger than the balance reverts with the *same*
`TIP20 token error: InsufficientBalance(...)` that a plain `transfer` produces — so it is really
implemented and really moves funds (an unregistered selector reverts differently, with `0xaa4bc69a`).
Live logs decode to text memos like `tempo-cherry-7966`, zero-padded exactly the way `packMemo` packs
them. Some are raw non-text bytes, which is why `unpackMemo` decodes non-fatally instead of throwing.

**Reads work from the browser.** The receipt page has no server of ours behind it — it calls the RPC
straight from the phone. Tempo's RPC answers preflight and POST with `access-control-allow-origin: *`,
so that works from a deployed origin, and so does the faucet button.

One thing that differs from the ABI in `lib/abi.ts`: a **successful** call to `transferWithMemo`
returns no data, while the ABI declares a `bool` output. That is harmless here — PayStub sends the
transaction and decodes nothing from the return value; the receipt is rebuilt from the `Transfer` /
`TransferWithMemo` **events** in the transaction receipt. A live `Transfer` carries exactly one
32-byte word (the value) and no memo, so the memo is only ever read from `TransferWithMemo`. The ABI
is left exactly as specified.

---

## Deploy from a phone, in six steps

1. **GitHub** — create a repository (`paystub`) and push this folder to it. From Termux:
   `git init && git add -A && git commit -m "PayStub" && git branch -M main && git remote add origin <your repo> && git push -u origin main`
2. **Vercel** — open [vercel.com/new](https://vercel.com/new) in the phone browser, sign in with
   GitHub, and **Import** the `paystub` repository. Framework preset: **Next.js**. No environment
   variables to add.
3. **Wait for Ready.** The build takes about a minute. When the deployment card says **Ready**, tap
   it and copy the `…vercel.app` URL.
4. **Open that URL in the wallet browser** — OKX Wallet → Discover/Browser tab → paste the URL. On
   desktop, MetaMask works too.
5. **Add Tempo Testnet** — tap **Connect wallet**, then **Switch to Tempo Testnet** if it appears,
   and approve the add-network prompt. Then tap **Get test USD** and watch the balance arrive.
6. **Send one test payment** — amount `1`, note `Logo for flyer`, payee a second address you
   control, then **Pay and issue receipt**. Confirm in the wallet, land on the PAID page, tap
   **Copy link** and open it somewhere else. That link is the whole product.

---

## Layout

```
app/
  layout.tsx              root layout, metadata, font stack
  providers.tsx           wagmi + react-query providers
  page.tsx                the only page: 01 Amount / 02 Pay / 03 Receipt
  globals.css             theme tokens for Tailwind v4
  r/[txHash]/page.tsx     receipt route (server shell)
  r/[txHash]/receipt-view.tsx   reads the chain, renders PAID / Confirming / Not found
lib/
  chains.ts               defineChain for Tempo testnet + mainnet, add-chain params
  wagmi.ts                injected connector, official RPC transports, ssr
  abi.ts                  the pathUSD ABI — the only contract in the project
  pathusd.ts              address, parse/format, packMemo, explorerTxUrl, faucet()
  format.ts               address shortening, time, clipboard that survives in-app browsers
```

Not a bank. Onchain receipt on Tempo. Colosseum World's Fair.
