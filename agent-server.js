require('dotenv').config()
// agent-server.js
// One seller agent as its own HTTP service (one container per agent).
//
//   AGENT_ID=summarizer-bot-2 AGENT_WIF=... node -r ./tracing.js agent-server.js
//
// Protocol (JSON over HTTP):
//   GET  /info                        -> { id, type, service, address }
//   POST /quote     { input }         -> { quoteId, ask, rounds }        (floor and cost stay private)
//   POST /negotiate { quoteId, offer } -> { decision: accept | counter | reject, price }
//   POST /service   { quoteId, txid }  -> 200 { text, data } once the payment is verified on-chain,
//                                         402 { error: 'payment-required', address, price } before that
//
// The provider keeps its own books in STATE_DIR/ledger-<id>.jsonl: what it was paid,
// what serving the request really cost, and the margin. The buyer never sees those.

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { PrivateKey } = require('@bsv/sdk')
const { PROVIDERS } = require('./providers')
const { verifyPayment } = require('./verify')
const { ensureFreshRate } = require('./rate')
const { providerPrice, ROUNDS } = require('./negotiate')
const { withSpan } = require('./spans')

const QUOTE_TTL_MS = 15 * 60 * 1000
const MAX_BODY = 64 * 1024

// Bodies over the limit are read to the end but not kept, so the client still gets a
// proper 413 instead of a dropped connection.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    let size = 0
    let tooBig = Number.isFinite(declared) && declared > MAX_BODY
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) tooBig = true
      if (!tooBig) chunks.push(c)
    })
    req.on('end', () => {
      if (tooBig) return reject(Object.assign(new Error('body-too-large'), { code: 413 }))
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(Object.assign(new Error('invalid-json'), { code: 400 })) }
    })
    req.on('error', reject)
  })
}

// Injectable for tests: provider, address, verifyFn, stateDir, rounds, now, rateFn.
function createAgentServer(opts = {}) {
  const agentId = opts.agentId || process.env.AGENT_ID
  const provider = opts.provider || PROVIDERS.find(p => p.id === agentId)
  if (!provider) throw new Error(`Unknown AGENT_ID "${agentId}". Known: ${PROVIDERS.map(p => p.id).join(', ')}`)
  const address = opts.address || (() => {
    const wif = process.env.AGENT_WIF || process.env[provider.envVar]
    if (!wif) throw new Error(`No wallet for ${provider.id}: set AGENT_WIF (or ${provider.envVar})`)
    return PrivateKey.fromWif(wif).toPublicKey().toAddress('testnet').toString()
  })()
  const verifyFn = opts.verifyFn || verifyPayment
  const rounds = opts.rounds || ROUNDS
  const now = opts.now || Date.now
  const rateFn = opts.rateFn || (() => ensureFreshRate(60))
  const stateDir = opts.stateDir || process.env.STATE_DIR || __dirname
  fs.mkdirSync(stateDir, { recursive: true })
  const ledgerPath = path.join(stateDir, `ledger-${provider.id}.jsonl`)

  const quotes = new Map()      // quoteId -> negotiation state
  const usedTxids = new Set()   // a payment can buy exactly one delivery
  // ...also across restarts: every txid this seller has ever served (or failed to serve
  // after payment) is in its ledger, so it is read back at start.
  try {
    for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { const e = JSON.parse(line); if (e.txid) usedTxids.add(e.txid) } catch { /* skip a damaged line */ }
    }
  } catch { /* no ledger yet */ }

  const ledger = entry => fs.appendFileSync(ledgerPath, JSON.stringify({ ts: new Date(now()).toISOString(), agent: provider.id, ...entry }) + '\n')
  const prune = () => { for (const [id, q] of quotes) if (now() - q.createdAt > QUOTE_TTL_MS) quotes.delete(id) }

  const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }

  async function handle(req, res) {
    const url = (req.url || '/').split('?')[0]
    if (req.method === 'GET' && url === '/info') return send(res, 200, { id: provider.id, type: provider.type, service: provider.service, address })
    if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true })
    if (req.method !== 'POST') return send(res, 404, { error: 'not-found' })

    let body
    try { body = await readJson(req) } catch (err) { return send(res, err.code || 400, { error: err.message }) }
    prune()

    if (url === '/quote') {
      if (typeof body.input !== 'string' || !body.input.trim()) return send(res, 400, { error: 'input-required' })
      return withSpan('quote', { 'agent.id': provider.id, 'input.chars': body.input.length }, async span => {
        await rateFn()
        const q = provider.quote(body.input)
        const quoteId = crypto.randomBytes(8).toString('hex')
        quotes.set(quoteId, { input: body.input, quote: q, round: 0, lastCounter: null, agreed: null, delivered: false, createdAt: now() })
        span.setAttribute('quote.ask', q.ask)
        send(res, 200, { quoteId, ask: q.ask, rounds })
      })
    }

    const st = quotes.get(body.quoteId)
    if (!st) return send(res, 404, { error: 'unknown-or-expired-quote' })

    if (url === '/negotiate') {
      const offer = body.offer
      if (!Number.isInteger(offer) || offer < 1) return send(res, 400, { error: 'offer-must-be-positive-integer' })
      return withSpan('negotiate', { 'agent.id': provider.id, 'negotiation.round': st.round + 1, 'negotiation.offer': offer }, async span => {
        let reply
        if (st.agreed !== null) reply = { decision: 'accept', price: st.agreed }                       // idempotent once agreed
        else if (st.lastCounter !== null && offer >= st.lastCounter) reply = { decision: 'accept', price: offer } // buyer takes our last counter
        else if (st.round >= rounds) reply = { decision: 'reject', price: null }
        else {
          const target = providerPrice(st.quote, st.round, rounds)
          st.round += 1
          if (offer >= target) reply = { decision: 'accept', price: offer }
          else { st.lastCounter = target; reply = { decision: 'counter', price: target } }
        }
        if (reply.decision === 'accept') st.agreed = reply.price
        span.setAttribute('negotiation.decision', reply.decision)
        if (reply.price !== null) span.setAttribute('negotiation.price', reply.price)
        send(res, 200, reply)
      })
    }

    if (url === '/service') {
      if (st.agreed === null) return send(res, 409, { error: 'no-deal' })
      if (st.delivered) return send(res, 409, { error: 'already-delivered' })
      if (typeof body.txid !== 'string' || !/^[0-9a-f]{64}$/.test(body.txid)) return send(res, 400, { error: 'txid-required' })
      if (usedTxids.has(body.txid)) return send(res, 409, { error: 'txid-already-used' })

      const paid = await withSpan('verify-payment', { 'agent.id': provider.id, 'payment.txid': body.txid, 'payment.sats': st.agreed }, () => verifyFn(body.txid, address, st.agreed))
      if (!paid) return send(res, 402, { error: 'payment-required', address, price: st.agreed })

      st.delivered = true; usedTxids.add(body.txid) // claim first, so a parallel request cannot get a second delivery
      try {
        const result = await withSpan('service-call', { 'agent.id': provider.id, 'service.type': provider.type }, async span => {
          const r = await provider.perform(st.input)
          span.setAttribute('service.real_cost_sats', r.actualCostSats)
          return r
        })
        ledger({ status: 'delivered', quoteId: body.quoteId, txid: body.txid, price: st.agreed, realCostSats: result.actualCostSats, marginSats: st.agreed - result.actualCostSats, estCostSats: st.quote.estCostSats, ask: st.quote.ask, floor: st.quote.floor, rounds: st.round, mocked: result.mocked })
        return send(res, 200, { text: result.text, data: result.data || null })
      } catch (err) {
        ledger({ status: 'paid-not-delivered', quoteId: body.quoteId, txid: body.txid, price: st.agreed, error: err.message })
        return send(res, 502, { error: 'service-failed', message: err.message })
      }
    }
    return send(res, 404, { error: 'not-found' })
  }

  const server = http.createServer((req, res) => { handle(req, res).catch(err => { try { send(res, 500, { error: err.message }) } catch { /* gone */ } }) })
  return { server, provider, address, quotes }
}

module.exports = { createAgentServer }

if (require.main === module) {
  let app
  try { app = createAgentServer() } catch (err) { console.error(err.message); process.exit(1) }
  const port = Number(process.env.AGENT_PORT || 4000)
  app.server.listen(port, '0.0.0.0', () => console.log(`[${app.provider.id}] ${app.provider.type} agent listening on :${port}, paid to ${app.address}`))
}
