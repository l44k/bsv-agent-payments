require('dotenv').config()
// consumer-remote.js
// The buyer agent talking to seller agents over HTTP (agent-server.js), one
// container each. It finds the sellers, negotiates with all of them in
// parallel, pays the cheapest deal on BSV testnet and asks for the service with
// the txid as proof. It only knows what a real buyer would know: asks, counters
// and agreed prices. Sellers' floors, costs and margins are in their own ledgers.
//
//   PROVIDER_URLS=http://summarizer-bot:4000,http://summarizer-bot-2:4000 \
//   CONSUMER_WIF=... node -r ./tracing.js consumer-remote.js
//
// Results go to STATE_DIR/runs.json (mode: "remote").

const { shutdownTracing } = require('./tracing')
const fs = require('fs')
const path = require('path')
const { trace, isSpanContextValid } = require('@opentelemetry/api')
const { payProvider, prefetchSpendable } = require('./payment')
const { quoteSats, satsToUsd, formatUsd } = require('./pricing')
const { ensureFreshRate, getBsvUsd } = require('./rate')
const { consumerOffer, OPEN_FACTOR } = require('./negotiate')
const { buildTasks } = require('./data/tasks')
const { withSpan } = require('./spans')

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Bold in a real terminal only (no escape codes in log files or pipes; NO_COLOR turns it off).
const bold = s => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[1m${s}\x1b[22m` : s)
const runsPath = () => path.join(process.env.STATE_DIR || __dirname, 'runs.json')

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let json = null
  try { json = await res.json() } catch { /* empty body */ }
  return { status: res.status, json }
}

// Ask every URL for /info; containers may still be starting, so retry for a while.
async function discover(urls, { attempts = 20, delayMs = 1000 } = {}) {
  const found = []
  for (const base of urls) {
    let info = null
    for (let i = 0; i < attempts && !info; i++) {
      try { const r = await fetch(`${base}/info`); if (r.ok) info = await r.json() } catch { /* not up yet */ }
      if (!info && i < attempts - 1) await sleep(delayMs)
    }
    if (info) found.push({ ...info, url: base })
    else console.log(`[consumer] ${base} did not answer, skipping it`)
  }
  return found
}

// Same buyer strategy as negotiate.js, but every offer is an HTTP round trip and the
// seller decides on its side. Taking a counter costs one extra call (offer = counter).
async function negotiateRemote(p, input, budget, { openFactor = OPEN_FACTOR } = {}) {
  return withSpan('negotiate', { 'provider.id': p.id, 'budget.sats': budget }, async span => {
    let calls = 0
    const done = (price, outcome, extra = {}) => {
      span.setAttribute('negotiation.outcome', outcome)
      span.setAttribute('negotiation.http_calls', calls)
      if (price !== null) span.setAttribute('negotiation.price', price)
      return { provider: p, price, outcome, calls, ...extra }
    }
    const q = await post(`${p.url}/quote`, { input }); calls++
    if (q.status !== 200) return done(null, `quote failed (${q.status})`, { rounds: 0 })
    const { quoteId, ask, rounds } = q.json
    const quote = { ask }
    const ceiling = Math.min(budget, ask)
    let lastCounter = null
    for (let r = 0; r < rounds; r++) {
      const offer = consumerOffer(quote, ceiling, r, rounds, openFactor)
      const res = await post(`${p.url}/negotiate`, { quoteId, offer }); calls++
      const d = res.json || {}
      if (d.decision === 'accept') return done(d.price, 'offer accepted', { quoteId, ask, rounds: r + 1 })
      if (d.decision !== 'counter') return done(null, 'rejected', { quoteId, ask, rounds: r + 1 })
      lastCounter = d.price
      const next = r < rounds - 1 ? consumerOffer(quote, ceiling, r + 1, rounds, openFactor) : ceiling
      if (d.price <= next) {
        const acc = await post(`${p.url}/negotiate`, { quoteId, offer: d.price }); calls++
        return acc.json && acc.json.decision === 'accept'
          ? done(acc.json.price, 'counter accepted', { quoteId, ask, rounds: r + 1 })
          : done(null, 'counter withdrawn', { quoteId, ask, rounds: r + 1 })
      }
    }
    return done(null, 'no deal', { quoteId, ask, rounds, lastCounter })
  })
}

async function runTaskRemote(task, { providers, consumerWif, payFn = payProvider, prefetchFn = prefetchSpendable, retryDelayMs = 3000, log = console.log }) {
  return withSpan('task', { 'task.type': task.type }, async span => {
    const t0 = Date.now(); const timings = {}
    const budget = quoteSats(task.budgetUsd)
    const record = { timestamp: new Date().toISOString(), mode: 'remote', taskType: task.type, taskPreview: task.description.slice(0, 80), bsvUsd: getBsvUsd(), budget, success: false }
    const traceId = span.spanContext().traceId
    if (isSpanContextValid(span.spanContext())) record.traceId = traceId
    const finish = () => {
      record.timings = { ...timings, totalMs: Date.now() - t0 }
      fs.appendFileSync(runsPath(), JSON.stringify(record) + '\n')
      log(`[timing] negotiation ${timings.negotiationMs ?? '-'} ms | payment ${timings.paymentBuildBroadcastMs ?? '-'} ms | service ${timings.serviceCallMs ?? '-'} ms | TOTAL ${record.timings.totalMs} ms`)
      return record
    }

    const candidates = providers.filter(p => p.type === task.type)
    log(`\n[consumer] Task: "${task.description.slice(0, 60)}..." (${task.type}), budget ${budget} sats, ${candidates.length} seller(s)${record.traceId ? `, trace ${record.traceId}` : ''}`)
    // Start the wallet's coin lookup now so it runs alongside the negotiation instead of
    // after it. Not awaited here; the payment picks the result up (or fetches again).
    if (prefetchFn) { try { prefetchFn(consumerWif) } catch { /* the payment will fetch itself */ } }
    const n0 = Date.now()
    const negs = await Promise.all(candidates.map(p => negotiateRemote(p, task.description, budget))) // in parallel
    timings.negotiationMs = Date.now() - n0
    record.negotiations = negs.map(n => ({ provider: n.provider.id, ask: n.ask ?? null, price: n.price, outcome: n.outcome, rounds: n.rounds ?? 0, httpCalls: n.calls }))
    negs.forEach(n => log(`  ${n.provider.id}: ask ${n.ask ?? '-'} -> ${n.price === null ? n.outcome : `${n.price} sats (${n.outcome}, ${n.calls} HTTP calls)`}`))

    const offers = negs.filter(n => n.price !== null).sort((a, b) => a.price - b.price)
    if (!offers.length) { log('[consumer] No deal within budget; nothing paid.'); return finish() }
    const w = offers[0]
    Object.assign(record, { winner: w.provider.id, agreedPrice: w.price, rounds: w.rounds })

    const p0 = Date.now()
    let txid, feeSats
    try {
      ({ txid, feeSats } = await withSpan('pay', { 'provider.id': w.provider.id, 'payment.sats': w.price }, () => payFn(consumerWif, w.provider.address, w.price)))
    } catch (err) {
      // nothing was broadcast, so nothing was paid: record it and go on with the next task
      timings.paymentBuildBroadcastMs = Date.now() - p0
      record.error = `payment failed: ${err.message}`
      log(`[consumer] Payment failed, nothing was sent: ${err.message}`)
      return finish()
    }
    timings.paymentBuildBroadcastMs = Date.now() - p0
    record.txid = txid
    record.priceUsd = satsToUsd(w.price, record.bsvUsd)
    if (Number.isFinite(feeSats)) { record.feeSats = feeSats; record.feeUsd = satsToUsd(feeSats, record.bsvUsd) }
    log(`[consumer] Paid ${w.price} sats (${formatUsd(record.priceUsd)}) to ${w.provider.id}` +
      (record.feeSats !== undefined ? `, network fee ${bold(`${record.feeSats} sats (${formatUsd(record.feeUsd)})`)}` : '') + `: ${txid}`)

    const s0 = Date.now()
    let r = await post(`${w.provider.url}/service`, { quoteId: w.quoteId, txid })
    if (r.status === 402) { await sleep(retryDelayMs); r = await post(`${w.provider.url}/service`, { quoteId: w.quoteId, txid }) } // seller had not seen it yet
    timings.serviceCallMs = Date.now() - s0 // seller's on-chain check + the service itself

    if (r.status === 200) { record.success = true; log(`[consumer] Result: ${r.json.text}`) }
    else if (r.status === 502) { record.paidButNotDelivered = true; record.error = r.json && r.json.message; log(`[consumer] PAID BUT NOT DELIVERED: ${record.error}`) }
    else { record.error = `service answered ${r.status} ${r.json && r.json.error}`; log(`[consumer] ${record.error}`) }
    return finish()
  })
}

async function main() {
  const urls = (process.env.PROVIDER_URLS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!urls.length) throw new Error('PROVIDER_URLS is empty (comma-separated seller URLs)')
  if (!process.env.CONSUMER_WIF) throw new Error('CONSUMER_WIF missing')
  await ensureFreshRate(60)
  const providers = await discover(urls)
  if (!providers.length) throw new Error('no seller answered')
  const sold = new Set(providers.map(p => p.type))
  const tasks = buildTasks().filter(t => sold.has(t.type)) // only tasks some seller can do
  console.log(`=== Remote session: ${providers.length} seller(s) [${providers.map(p => p.id).join(', ')}], ${tasks.length} task(s), 1 BSV = $${getBsvUsd()} ===`)
  const start = Date.now(); let ok = 0
  for (const t of tasks) { if ((await runTaskRemote(t, { providers, consumerWif: process.env.CONSUMER_WIF })).success) ok++ }
  console.log(`\n[session] ${ok}/${tasks.length} completed in ${Date.now() - start} ms; results in ${runsPath()}`)
}

module.exports = { discover, negotiateRemote, runTaskRemote, main }

if (require.main === module) {
  main()
    .catch(err => { console.error('[consumer] Fatal:', err.message); process.exitCode = 1 })
    .finally(() => shutdownTracing())
}
