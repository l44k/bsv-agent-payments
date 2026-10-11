# Development log

This was the README while the project was being built, version by version. It is kept as a record of how the design evolved; for how the system works today, see README.md. (The rain-jacket tablet described under v10 has since been removed.)

---

# BSV Agent-to-Agent Micropayment Demo

Two tiny "AI agents":

- **Provider** — sells a service (a random fact) for 100 satoshis a call.
- **Consumer** — pays the Provider and gets the result.

This is the core pattern behind agentic payments: one agent pays another,
instantly, in a fraction of a cent, with no human clicking "approve."

## Setup

```bash
npm install
node wallet.js
```

This prints a WIF (private key) and address for each agent. Paste:
- the PROVIDER WIF into `provider.js`
- the CONSUMER WIF into `consumer.js`

## Fund the consumer

Get free testnet BSV from a faucet, e.g.:
https://witnessonchain.com/faucet/tbsv

Send it to the **consumer** address. Then look up that funding transaction
on a testnet explorer (e.g. https://test.whatsonchain.com) and copy its
`txid`, `vout`, `satoshis`, and locking script hex into the `UTXO` object
in `consumer.js`.

## Run it

```bash
node consumer.js
```

You'll see the consumer build and sign a payment transaction, "send" it to
the provider, and get a fact back — a full pay-then-deliver exchange
between two independent scripts, each holding its own keys.

## Making it fully live (real network calls)

This demo stubs two network calls so it runs offline. To make it real:

1. **Broadcast the payment tx** — in `consumer.js`, after `tx.sign()`, POST
   `tx.toHex()` to a broadcaster, e.g. WhatsOnChain's
   `POST /v1/bsv/test/tx/raw` endpoint.

2. **Verify payment on the provider side** — in `provider.js`,
   `verifyPayment()` should call WhatsOnChain's
   `GET /v1/bsv/test/tx/hash/{txid}` (or check the raw tx outputs directly)
   to confirm it actually pays >= `PRICE_SATS` to the provider's address.
   BSV supports trusting 0-conf (unconfirmed) transactions for
   instant micropayments, which is what makes this usable for
   real-time agent-to-agent exchanges.

3. **Turn `provider.js` into a real endpoint** — wrap `handleRequest()` in
   an HTTP server (Express) or an MCP tool, so a separate agent process
   (even one you don't control) can call it over the network instead of
   importing it directly like this demo does.

## Multi-provider negotiation (v2)

`providers.js`, `negotiate.js`, and `run-negotiation.js` add the actually
"agentic" part: three providers sell different services at different
prices, and the consumer agent negotiates with whichever one(s) match the
task, picks the best affordable deal, and walks away if nothing fits its
budget.

```bash
node run-negotiation.js
```

This is the piece worth writing up in an evaluation chapter — it already
surfaced one real bug during dev (an agent accepting a deal that exceeded
its own budget), which is exactly the kind of failure mode worth
documenting rather than hiding. Good candidates to test/measure further:

- Vary provider floor prices and watch when deals stop closing
- Add more providers per task type and confirm the agent always finds the cheapest
- Log every negotiation round to a file and turn it into a chart (rounds-to-close, success rate vs. budget tightness)
- Wire this into the real payment code from `consumer.js`/`provider.js` so the winning provider only performs the service after a verified on-chain payment

## Real AI-backed pricing (v3)

`pricing.js` and `ai-service.js` replace the fake service outputs with real
Claude Haiku API calls, and price each provider from **actual API cost**,
not arbitrary numbers.

```bash
export ANTHROPIC_API_KEY=your-key-here   # omit to run in mock mode
node run-negotiation.js
```

**A genuinely useful finding surfaced while building this**, worth writing
up directly: at BSV's current low USD price (~$15 at time of writing), a
single small Haiku API call costs roughly **1,400–1,700 satoshis** — not
the 100–200 sats the earlier arbitrary demo prices assumed. Converting
small USD amounts into BSV's satoshi units stops being trivially "cheap"
once the coin's own price is low; the *fee* stays negligible, but the
*price of the underlying service* denominated in sats can look
surprisingly large. That's a real, citable observation about
BSV-denominated micropayments for AI services, not a bug — and it's the
kind of thing an evaluation chapter should highlight rather than quietly
fix and never mention.

Run summary now logs three numbers per session: total quoted/paid,
total real API cost, and the margin providers actually captured — useful
data for testing whether your negotiation logic reliably keeps providers
profitable, or whether aggressive consumer negotiation can push deals
into a loss (try lowering `floorPrice` values below real cost and see
what happens).

## Full working pipeline (v4) — real payments, real verification

`chain.js`, `payment.js`, `verify.js`, and `full-pipeline.js` connect
everything into one real, end-to-end flow: negotiate → build & broadcast a
real BSV testnet payment → verify it on-chain → only then run the AI
service. This is the actual working milestone — everything before this
file was tested pieces; this is them wired together.

### Setup

```bash
npm install
node setup-env.js   # creates .env with 4 testnet keys, prints the CONSUMER address
```

Then open `.env` and paste your `ANTHROPIC_API_KEY` (leave empty for mock AI mode).
Never commit or share `.env`.

Fund the **consumer** wallet only, via a testnet faucet:
https://witnessonchain.com/faucet/tbsv

Then:

```bash
node full-pipeline.js
```

### What actually happens when you run it

1. Consumer negotiates with the matching provider (same logic as before)
2. On agreement, `payment.js` fetches the consumer's live UTXOs from
   WhatsOnChain, builds a real signed transaction, and broadcasts it to
   BSV testnet
3. `verify.js` checks the broadcast transaction on-chain to confirm it
   really pays the agreed amount to the provider's address
4. Only after verification does the provider call the real Claude API and
   return the result

This couldn't be tested inside the build sandbox (its network is
restricted to package registries, not blockchain APIs), so run it from
your own machine. If a payment doesn't verify right away, testnet
propagation can lag a few seconds — the script tells you this and you can
just rerun.

### Known rough edges (good material for your limitations section)

- Each "provider" is really just the consumer's own script calling its own
  functions with a different keypair — a true multi-agent version would
  run each provider as its own independent process/server
- No retry/backoff on the verification check — real-world agents would
  need one, since a rejection right now might just mean "check again in a
  few seconds"
- Change output isn't swept, so wallets will accumulate dust UTXOs over
  many runs — fine for a demo, not for production

## Six agents, real competition (v5)

`providers.js` now has **5 providers across 3 task types**, so the
consumer's cheapest-wins logic actually has competitors to choose between,
not just one negotiation per task:

| id | type | role |
|---|---|---|
| summarizer-bot | summarize | baseline pricing |
| summarizer-bot-2 | summarize | undercuts summarizer-bot |
| analysis-bot | lookup | baseline pricing |
| analysis-bot-2 | lookup | undercuts analysis-bot |
| compute-bot | compute | sole provider |
| translator-bot | translate | new service type — translates to Portuguese |

That's **6 agents total** (1 consumer + 5 providers). `full-pipeline.js` now
negotiates with every matching provider before paying anyone, then pays
only the cheapest agreed offer — real competitive selection, not just
sequential accept-the-first-offer.

If you already have a `.env` from an earlier version, run:

```bash
node add-agents.js
```

This appends only the new provider wallets — it never touches your
existing `CONSUMER_WIF`, `ANTHROPIC_API_KEY`, or already-funded keys.

## Real, varied data to negotiate over + result logging (v6)

`data/tasks.js` replaces the single hardcoded task with **5 real, varied
pieces of content** across all 3 service types — different lengths and
complexity, so real AI cost genuinely varies run to run instead of being
the same number every time:

- 2 customer feedback samples to summarize (one short/punchy, one longer)
- a business report excerpt to extract key info from
- a short message to translate to Portuguese
- 2 small word-problems for the compute service

`full-pipeline.js` now runs through all 5 in one session and appends a
JSON record per task to `runs.json` — one line each, with timestamp, task
type, winner, agreed price, real AI cost, margin, and full timing
breakdown. This is your evaluation chapter's raw data source: run it
several times over a few days and you'll have a real dataset of cost,
margin, and latency variance to analyze and chart.

```bash
node full-pipeline.js
cat runs.json   # every run's results, one JSON object per line
```

Add more content any time by editing the sample arrays in
`data/tasks.js` — no other file needs to change.

## Live exchange rate: `rate-bot`, `rate.json`, `update-rate.js` (v7)

A 7th agent, `rate-bot`, sells the current BSV/USD rate (fetched from
WhatsOnChain's `exchangerate` endpoint, mainnet — testnet coins have no
price). The rate is cached in `rate.json`, and `pricing.js` reads it on
every conversion, so **everything is priced from it**:

- provider prices and consumer budgets are now defined in **USD** and
  converted to sats at the cached rate whenever they are used
  (at $15/BSV they equal the old sat values exactly)
- measured Claude API costs use the same rate

Two ways to refresh the rate:

1. **Inside the pipeline (agent flow):** if `rate.json` is missing or older
   than `RATE_MAX_AGE_MIN` (default 60) minutes, `full-pipeline.js` first
   negotiates, pays and verifies a rate purchase like any other task, then
   saves the result. It shows up in `runs.json` with its timings and margin.
2. **Free, direct:** `npm run update-rate` (or `node update-rate.js`)
   fetches the rate itself, no agents or payment.
3. **Live in the background:** `npm run watch-rate` keeps `rate.json`
   refreshed every 60 s (`node update-rate.js --watch 30` for 30 s, min 5).
   A failed refresh keeps the last good rate and retries. With this running
   in a second terminal the cached rate is never stale, so the pipeline
   uses it as is and does NOT buy one from `rate-bot`. To demo the agent
   purchase every session instead, stop the watcher and set
   `RATE_MAX_AGE_MIN=0` in `.env`.

Safety and failure handling worth writing up:

- A purchased rate that is more than 2x away from the cached one is
  **refused** (the agent can't verify what it buys, so it sanity-checks).
  The payment has still happened by then.
- If a provider fails after being paid, the run is logged as
  `paidButNotDelivered` and the session continues. There is no escrow or
  refund in this demo.
- This does not fix negative margins: floors are still fixed USD numbers,
  not derived from the real cost of each request.

## Wallet and the indexer: why back-to-back payments work now (v8)

Several payments in a row spend each other's unconfirmed change, and the
indexer lags behind the network, so the wallet needs care:

- `chain.js` lists UTXOs via WhatsOnChain's `/unspent/all`, which includes
  unconfirmed outputs and flags those already spent in the mempool
  (`isSpentInMempoolTx`). The older `/unspent` had no such flag, so a second
  payment right after the first re-used the same coins and the node rejected
  it as `txn-mempool-conflict` (a double-spend attempt).
- `payment.js` also remembers what it spent and the change it created, and
  saves its own transactions to `wallet-txs.json`. Spending unconfirmed
  change needs the parent transaction, which the API does not always serve
  yet, so the next run reads it from that file. Delete the file any time;
  the worst case is that the wallet asks the API instead.
- If the node still reports a conflict, the payment waits 3 s and retries
  (3 attempts), then fails with the node's error rather than guessing.

Known limit: if the parent of your only spendable coin is unconfirmed, was
made before `wallet-txs.json` existed, and the API won't serve it, the
payment fails with `getRawTxHex failed: 404` until a block confirms it.

## Cost-based prices and real bargaining rounds (v9)

Before, floor prices were fixed numbers below the real cost of the request,
and the consumer opened at 70 % of ask, which was already above every floor.
So every deal closed in round one, at a loss. Now:

- **Providers quote per request.** `providers.js` estimates what a request
  will cost (prompt length in tokens + a typical answer length for that
  service), then `floor = cost x (1 + floorMargin)` and
  `ask = cost x (1 + askMargin)`. Longer input, higher price. The budget
  competitors (`-bot-2`) run thinner margins.
- **One shared protocol** (`negotiate.js`, used by the pipeline and the
  offline demo): alternating offers over up to 5 rounds. The provider
  concedes from ask to its private floor, the consumer from 50 % of ask up to
  min(budget, ask), and the consumer takes a counter as soon as it is within
  its next planned offer. Deals land between floor and ceiling (about
  mid-range on average), and there is no deal when the budget is below the floor.
- **Task budgets retuned** in `data/tasks.js`. The compute task is
  deliberately below the cost of the request: the agent walks away and pays
  nothing (so a normal session shows 4/5 tasks completed).
- `runs.json` now records every provider's ask, private floor and cost
  estimate per negotiation, the rounds used, and `estErrorSats` (real cost
  minus the winner's estimate). `VERBOSE=1 node full-pipeline.js` prints the
  round-by-round transcript.

Caveats: the estimator's constants (`INPUT_OVERHEAD_TOKENS`,
`expectedOutputTokens`, margins) were calibrated on one live run (five
requests), so its accuracy on that run says little about new inputs. Negative
margins are still possible when an answer comes out much longer than expected
and the deal is near the floor; tune those constants in `providers.js` after
collecting more runs. Comparing `estErrorSats` across runs is a good
evaluation-chapter metric.

## Analysis and the rain-jacket tablet (v10)

**`npm run analyze`** reads `runs.json` and prints outcomes (completed / no deal /
paid but failed), money (paid vs provider cost vs margin), per task type and per
provider (cost-estimate error, mean and spread), competition, latency (median, p95,
max per stage), rate purchases and rain checks. `node analyze.js --csv > runs.csv`
gives one flat row per task for Excel or charts. Older records with missing fields
are handled.

**Rain-jacket check = a two-step chain of paid agents.** `rain-check.js` buys an
hourly forecast summary from `weather-bot` (Open-Meteo, free upstream, so a fixed
market price) and then a short piece of advice about it from `advice-bot`
(Claude Haiku, answers in Finnish). Both steps are normal negotiated, paid and
verified tasks and appear in `runs.json`. The YES / MAYBE / NO verdict comes from a
plain rule in `weather.js` (next 6 hours: YES at >= 50 % rain probability or >= 1 mm,
MAYBE at >= 30 % or >= 0.2 mm). The purchased advice is checked against the rule and
any disagreement is logged (`agree: false`): the agent cannot verify what it buys, so
it does not blindly trust it. If the advice step fails, the verdict still comes from
the forecast. One check costs about 3 500 sats (most of it is the advice).

```bash
node add-agents.js     # two new wallets: weather-bot and advice-bot
npm run rain           # one check from the terminal, try this first
```

**The tablet** only shows a page and a button; the keys, the paying and the thinking
stay on your computer.

```bash
npm run tablet         # prints an address like http://192.168.1.20:3000
```

Open that address in the tablet's browser (same Wi-Fi). The page is old-style
JavaScript (ES5, XMLHttpRequest) so old browsers can run it. **Nothing runs by
itself**: a forecast is bought only when the button is pressed. The page polls the
last stored answer every 30 s, which is free. Spending is limited by a cooldown
(`TABLET_COOLDOWN_MIN`, default 10 min, presses inside it get the cached answer) and a
daily cap (`TABLET_MAX_CHECKS_PER_DAY`, default 12). Anyone on your Wi-Fi can press
the button, so keep it off the internet. Location: `WEATHER_LAT`, `WEATHER_LON`,
`WEATHER_LABEL` in `.env` (default Rio de Janeiro; coordinates are rounded to two
decimals). The last answer is kept in `rain-last.json`.

## Pay-per-print with BSV (v11)

`print-shop.js` is a small print service. A customer opens a page, uploads a PDF and
gets a price and a payment address; when the payment shows up, the PDF is printed.

1. The PDF is uploaded and its pages are counted (`pdf-lib`). Price: **$0.10 per
   started block of 5 pages** (`PRINT_PRICE_USD`), converted to sats at the current
   BSV/USD rate. The rate is refreshed first if it is stale, and the shop refuses to
   quote from a rate older than 24 h or from the built-in fallback.
2. The job gets **its own payment address**, derived (BRC-42) from one master key and
   the job id. A payment to it can only mean that job, so nobody has to identify
   themselves, and all funds are recoverable from the master key (`node print-key.js
   <jobId>` prints a job's address and WIF). The quote is valid for 15 minutes.
3. The shop watches the addresses of waiting jobs only. When at least the quoted
   amount is visible on the network (0-conf; `PRINT_MIN_CONF=1` waits for a block), the
   PDF is printed, limited to the pages that were paid for, and then deleted.
   Underpayment waits for a top-up, overpayment is reported and not refunded, a payment
   after expiry is not printed. If the printer fails after payment the job stays paid
   and the page offers a retry.

```bash
npm install                    # new dependencies: pdf-lib, pdf-to-printer
node print-shop.js --init      # once: creates PRINTER_MASTER_WIF in .env, back it up
npm run print-shop             # prints an address like http://192.168.1.20:3100
```

**Testing without a printer or real money** (the defaults): `PRINT_MODE=dry` copies the
PDF to `printed/` instead of printing, and `PRINT_NETWORK=test` uses testnet coins.
The price is still computed at the real mainnet rate, so $0.10 is about 500 000 sats,
more than a small testnet wallet holds: set `PRINT_PRICE_USD=0.002` (about 10 000
sats) for testing. Pay the shown invoice with
`node pay-invoice.js <address> <sats>` (uses your CONSUMER wallet).

**A real printer:** `PRINT_MODE=real`, optionally `PRINTER_NAME=...` (default printer if
empty). Windows uses `pdf-to-printer`, other systems `lp`. Real printing has not been
tested here; try it with a single page first.

**Real money (`PRINT_NETWORK=main`)** is a different level of responsibility. It has
not been tested against the real mainnet. Back up `PRINTER_MASTER_WIF` (it can spend
every payment), test with tiny amounts first, and remember that customers need a
mainnet BSV wallet that can pay a `1...` address (there is no QR code yet). Payments stay
at the per-job addresses until you spend them, and there is no sweep tool yet. 0-conf
means a payer could double-spend after the print; for cents that risk is small, for
more use `PRINT_MIN_CONF=1`. Taking real payments from other people may have tax and
legal implications; check them yourself.

There is no login, HTTPS or rate limiting on the page: keep it on your own network.

## Agents in their own containers, with distributed tracing (v12)

First slice of the containerised version: the buyer and two competing summarizer
agents run as separate services and talk over HTTP; every task is one trace in
Jaeger across all of them.

```bash
docker compose up --build -d jaeger summarizer-bot summarizer-bot-2
docker compose run --rm consumer      # one session; repeat as often as you like
# Jaeger UI: http://localhost:16686  -> service "consumer" -> one trace per task
```

- **`agent-server.js`**: one seller as an HTTP service (`/info`, `/quote`, `/negotiate`,
  `/service`). Its floor and cost estimate never leave the container. `/service`
  answers **402 Payment Required** until the payment is verified on-chain, then calls
  the LLM once. A txid buys exactly one delivery. The seller keeps its own books in
  `state/<agent>/ledger-<agent>.jsonl` (paid, real cost, margin).
- **`consumer-remote.js`**: the buyer finds the sellers (`PROVIDER_URLS`), negotiates
  with all of them in parallel, pays the cheapest deal and requests the service with
  the txid. It only records what a real buyer can know (`state/consumer/runs.json`,
  `mode: "remote"`), plus the trace id of each task.
- **Same negotiation as before**: tested to land on the identical price as the
  in-process version in 300 random cases; it just costs HTTP round trips now (about 5.5
  calls per negotiation).
- **Tracing** (`tracing.js`): OpenTelemetry with automatic HTTP and fetch spans plus
  our own spans (`task`, `negotiate`, `pay`, `quote`, `verify-payment`, `service-call`).
  The trace context travels in the `traceparent` header. Tracing is off when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, and the agents keep working if Jaeger is down.
  Only traces are exported (Jaeger takes no metrics).
- **Secrets**: compose reads `.env` for `${...}` and gives each service only its own
  values: sellers get their wallet and the Claude key, the buyer gets the paying
  wallet. Nothing secret is in the image (`.dockerignore`).
- **State** is in `state/<service>/` (bind mounts). On Linux, create the folders and
  give them to uid 1000 (`mkdir -p state/{consumer,summarizer-bot,summarizer-bot-2} &&
  sudo chown -R 1000:1000 state`); Docker Desktop on Windows needs nothing.
- Don't run the old host pipeline and the container buyer at the same moment: they
  share one wallet and could pick the same coins (the retry handles it, but slowly).

- **Analysis**: `node analyze.js --state state` (or just `node analyze.js` when there is no
  `runs.json` in the folder) reads the buyer's `state/consumer/runs.json` and every seller's
  ledger, and joins them on the payment txid. That gives container runs the same money and
  cost-estimate tables as host runs (the buyer alone cannot know the seller's cost), plus a
  per-seller table, a list of payments that no seller recorded (paid, nothing delivered),
  and latency for container runs separately, including the HTTP negotiation time.
  `--csv` adds `mode`, `traceId` and the ledger status to every row.

Not tested here: building and running the containers (no Docker in the build
environment). Tested: the services over real HTTP, the protocol, the CLI start as in the
container, and that spans reach an OTLP endpoint with the right service names.

## Where this goes next

- Swap the "random fact" for a real paid resource: an LLM call, a scraped
  dataset, compute time, an API you meter per request.
- Add a price list so the provider can quote different services.
- Let the consumer agent decide *whether* to pay based on its own budget —
  that's the actual "agentic" part: autonomous spending decisions, not
  just autonomous transaction signing.
