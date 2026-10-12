require('dotenv').config()
// full-pipeline.js
// The complete working system: (refresh the BSV/USD rate if stale) ->
// negotiate with every matching provider -> pick the cheapest agreed deal ->
// real BSV testnet payment -> verify on-chain -> service delivered.
// Runs against real, varied task content (data/tasks.js) and logs every
// result to runs.json.
//
// The exchange rate is itself bought from a rate agent through this same
// flow, saved to rate.json, and used to convert all USD prices and budgets
// to sats. For a free refresh without running any agents: node update-rate.js
//
// Setup: `node setup-env.js` (first time) / `node add-agents.js` (new
// agents), fund CONSUMER via a testnet faucet, ANTHROPIC_API_KEY in .env
// (blank = mock AI mode).
//
// Run: node full-pipeline.js
// (also importable: exports runTask and main)

const fs = require('fs')
const { PrivateKey } = require('@bsv/sdk')
const { PROVIDERS } = require('./providers')
const { negotiate } = require('./negotiate')
const { payProvider } = require('./payment')
const { verifyPayment } = require('./verify')
const { buildTasks, RATE_TASK } = require('./data/tasks')
const { quoteSats, satsToUsd, formatUsd } = require('./pricing')
const { getBsvUsd, isStale, saveRate, describeRate } = require('./rate')

const CONSUMER_WIF = process.env.CONSUMER_WIF
if (!CONSUMER_WIF) {
  console.error('Set CONSUMER_WIF in .env (run `node setup-env.js`) before running.')
  process.exit(1)
}

const RUNS_LOG_PATH = 'runs.json'
const RATE_MAX_AGE_MIN = Number(process.env.RATE_MAX_AGE_MIN || 60)

function providerAddress(provider) {
  const wif = process.env[provider.envVar]
  if (!wif) throw new Error(`Missing ${provider.envVar} in .env — run node add-agents.js`)
  return PrivateKey.fromWif(wif).toPublicKey().toAddress('testnet').toString()
}

async function runTask(task) {
  const overallStart = Date.now()
  const timings = {}
  const budget = quoteSats(task.budgetUsd) // converted at the current cached rate
  const record = {
    timestamp: new Date().toISOString(),
    taskType: task.type,
    taskPreview: task.description.slice(0, 80),
    bsvUsd: getBsvUsd(),
    budget,
    success: false
  }

  const finish = () => {
    record.timings = { ...timings, totalMs: Date.now() - overallStart }
    printTimings(timings, overallStart)
    appendRun(record)
    return record
  }

  const candidates = PROVIDERS.filter(p => p.type === task.type)
  console.log(`\n[pipeline] Task: "${task.description.slice(0, 60)}..." (${task.type}), budget ${budget} sats @ $${record.bsvUsd}/BSV`)
  console.log(`[pipeline] ${candidates.length} provider(s) offer this service — negotiating with each...`)

  const negotiateStart = Date.now()
  const negotiations = candidates.map(provider => negotiate(provider, task.description, budget))
  timings.negotiationMs = Date.now() - negotiateStart

  for (const n of negotiations) {
    console.log(n.price === null
      ? `  ${n.provider.id}: ask ${n.quote.ask} -> no deal (its final price ${n.lastPrice} is above my budget ${budget})`
      : `  ${n.provider.id}: ask ${n.quote.ask} -> deal at ${n.price} (${n.outcome}, round ${n.rounds})`)
    if (process.env.VERBOSE === '1') n.transcript.forEach(line => console.log(`      ${line}`))
  }
  const offers = negotiations.filter(n => n.price !== null)
  record.candidatesQueried = candidates.length
  record.offersReceived = offers.length
  // Provider-side numbers (ask, private floor, cost estimate) are recorded for analysis only.
  record.negotiations = negotiations.map(n => ({
    provider: n.provider.id, ask: n.quote.ask, floor: n.quote.floor, estCostSats: n.quote.estCostSats,
    price: n.price, outcome: n.outcome, rounds: n.rounds
  }))

  if (offers.length === 0) {
    console.log(`[pipeline] No provider agreed within budget. Task not completed.`)
    return finish()
  }

  offers.sort((a, b) => a.price - b.price)
  const { provider, price, quote, rounds } = offers[0]
  record.winner = provider.id
  record.agreedPrice = price
  record.rounds = rounds
  record.estCostSats = quote.estCostSats
  console.log(`[pipeline] Winner: ${provider.id} at ${price} sats (cheapest of ${offers.length} offers, ${rounds} rounds). Building real payment tx...`)

  const address = providerAddress(provider)
  const paymentStart = Date.now()
  const { txid, feeSats } = await payProvider(CONSUMER_WIF, address, price)
  timings.paymentBuildBroadcastMs = Date.now() - paymentStart
  record.txid = txid
  record.priceUsd = satsToUsd(price, record.bsvUsd)
  if (Number.isFinite(feeSats)) { record.feeSats = feeSats; record.feeUsd = satsToUsd(feeSats, record.bsvUsd) }
  console.log(`[pipeline] Paid ${price} sats (${formatUsd(record.priceUsd)})` + (record.feeSats !== undefined ? `, network fee ${record.feeSats} sats (${formatUsd(record.feeUsd)})` : ''))
  console.log(`[pipeline] Broadcast: ${txid} (${timings.paymentBuildBroadcastMs} ms to build+broadcast)`)
  console.log(`[pipeline] Verifying payment on-chain...`)

  const verifyStart = Date.now()
  const ok = await verifyPayment(txid, address, price)
  timings.verificationMs = Date.now() - verifyStart

  if (!ok) {
    console.log(`[pipeline] Payment not yet visible on-chain — provider refuses service.`)
    console.log(`[pipeline] (Testnet propagation can lag a few seconds — try rerunning.)`)
    return finish()
  }
  console.log(`[pipeline] Payment verified (${timings.verificationMs} ms). Running service...`)

  const serviceStart = Date.now()
  let result
  try {
    result = await provider.perform(task.description)
  } catch (err) {
    timings.serviceCallMs = Date.now() - serviceStart
    console.log(`[pipeline] PAID BUT NOT DELIVERED: ${provider.id} failed after payment (${err.message}).`)
    console.log(`[pipeline] (This demo has no escrow or refund — worth noting in the limitations.)`)
    record.error = err.message
    record.paidButNotDelivered = true
    return finish()
  }
  timings.serviceCallMs = Date.now() - serviceStart

  console.log(`[pipeline] Result: ${result.text}`)
  console.log(`[pipeline] Real cost: ${result.actualCostSats} sats | Paid: ${price} sats | Margin: ${price - result.actualCostSats} sats`)
  if (quote.estCostSats > 0) {
    const err = result.actualCostSats - quote.estCostSats
    console.log(`[pipeline] Provider's cost estimate was ${quote.estCostSats} sats (off by ${err >= 0 ? '+' : ''}${err}, ${((err / quote.estCostSats) * 100).toFixed(0)}%)`)
    record.estErrorSats = err
  }

  // A purchased exchange rate becomes the rate everything else is priced at.
  if (task.type === 'rate' && result.data) {
    const saved = saveRate(result.data.bsvUsd, { source: `agent:${provider.id}`, sourceTime: result.data.sourceTime, txid, paidSats: price })
    if (saved.ok) {
      record.rateUpdate = { newRate: result.data.bsvUsd, previous: saved.record.previous }
      console.log(`[rate] rate.json updated: 1 BSV = $${result.data.bsvUsd} (bought from ${provider.id} for ${price} sats)`)
    } else {
      record.rateUpdate = { refused: saved.reason }
      console.log(`[rate] Purchased rate refused: ${saved.reason}`)
    }
  }

  record.success = true
  record.realAiCostSats = result.actualCostSats
  record.marginSats = price - result.actualCostSats
  record.mocked = result.mocked
  finish()
  record.result = { text: result.text, data: result.data } // for callers; appended to runs.json before this line, so not logged
  return record
}

function printTimings(timings, overallStart) {
  const totalMs = Date.now() - overallStart
  console.log(`[timing] negotiation: ${timings.negotiationMs ?? '-'} ms`)
  if (timings.paymentBuildBroadcastMs !== undefined) console.log(`[timing] payment build+broadcast: ${timings.paymentBuildBroadcastMs} ms`)
  if (timings.verificationMs !== undefined) console.log(`[timing] on-chain verification: ${timings.verificationMs} ms`)
  if (timings.serviceCallMs !== undefined) console.log(`[timing] service call: ${timings.serviceCallMs} ms`)
  console.log(`[timing] TOTAL end-to-end: ${totalMs} ms (${(totalMs / 1000).toFixed(2)} s)`)
}

// Appends one JSON record per line to runs.json (creates it if missing).
// Kept simple/append-only so a crash mid-session never corrupts prior runs.
function appendRun(record) {
  fs.appendFileSync(RUNS_LOG_PATH, JSON.stringify(record) + '\n')
}

async function main() {
  const sessionStart = Date.now()
  const tasks = buildTasks()
  console.log(`=== Full pipeline run: ${tasks.length} real task(s), real testnet payments ===\n`)

  if (isStale(RATE_MAX_AGE_MIN)) {
    console.log(`[session] BSV/USD rate missing or older than ${RATE_MAX_AGE_MIN} min — buying a fresh one from a rate agent first...`)
    try {
      await runTask(RATE_TASK)
    } catch (err) {
      console.log(`[session] Rate refresh failed (${err.message}) — continuing with ${describeRate()}.`)
    }
  } else {
    console.log(`[session] Using cached BSV/USD rate: ${describeRate()}`)
  }
  console.log(`[session] All prices and budgets converted at 1 BSV = $${getBsvUsd()}`)

  const results = []
  for (const task of tasks) {
    results.push(await runTask(task))
  }
  const succeeded = results.filter(r => r.success).length
  console.log(`\n[session] ${succeeded}/${tasks.length} tasks completed successfully.`)
  console.log(`[timing] SESSION TOTAL: ${Date.now() - sessionStart} ms`)
  console.log(`[session] All results appended to ${RUNS_LOG_PATH}`)
}

module.exports = { runTask, main }

if (require.main === module) {
  main().catch(err => {
    console.error('[pipeline] Fatal error:', err.message)
    process.exit(1)
  })
}
