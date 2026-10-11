// rate.js
// BSV/USD exchange rate: fetch, validate, cache to rate.json.
// pricing.js reads the cached rate on every conversion, so updating
// rate.json (by buying a rate from an agent, or via `node update-rate.js`)
// changes every price, budget and cost calculation without touching code.

const fs = require('fs')
const path = require('path')

// STATE_DIR lets a container keep its state on a volume (default: the project folder).
const RATE_PATH = path.join(process.env.STATE_DIR || __dirname, 'rate.json')
const FALLBACK_BSV_USD = 15.0 // used only until a first rate has been saved
// Mainnet on purpose: testnet coins have no market price.
const RATE_URL = 'https://api.whatsonchain.com/v1/bsv/main/exchangerate'

function readRate() {
  try {
    return JSON.parse(fs.readFileSync(RATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

function getBsvUsd() {
  const r = readRate()
  return r && r.bsvUsd > 0 ? r.bsvUsd : FALLBACK_BSV_USD
}

function rateAgeMinutes() {
  const r = readRate()
  if (!r || !r.fetchedAt) return Infinity
  return (Date.now() - new Date(r.fetchedAt).getTime()) / 60000
}

function isStale(maxAgeMin) {
  return rateAgeMinutes() > maxAgeMin
}

function describeRate() {
  const r = readRate()
  if (!r) return `$${FALLBACK_BSV_USD} (built-in fallback, no rate.json yet)`
  return `$${r.bsvUsd} (${r.source || 'unknown source'}, ${Math.round(rateAgeMinutes())} min old)`
}

// Response shape per WhatsOnChain docs: { rate: 27.055, time: 1752257180, currency: "USD" }
async function fetchRateFromChain() {
  const res = await fetch(RATE_URL)
  if (!res.ok) throw new Error(`exchangerate request failed: ${res.status}`)
  const data = await res.json()
  const bsvUsd = Number(data.rate)
  if (!(bsvUsd > 0) || data.currency !== 'USD') {
    throw new Error(`unexpected exchangerate response: ${JSON.stringify(data)}`)
  }
  const sourceTime = data.time ? new Date(data.time * 1000).toISOString() : null
  return { bsvUsd, sourceTime }
}

// Validates and persists a rate. With guard on (default), a rate that jumps
// more than 2x up or down from the cached one is refused — a cheap defence
// against a buggy or dishonest seller, since agents pay for this data
// without being able to verify it themselves.
function saveRate(bsvUsd, meta = {}, { guard = true } = {}) {
  const n = Number(bsvUsd)
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'not a positive number' }

  const prev = readRate()
  if (guard && prev && prev.bsvUsd > 0) {
    const ratio = n / prev.bsvUsd
    if (ratio > 2 || ratio < 0.5) {
      return { ok: false, reason: `$${n} is more than 2x away from cached $${prev.bsvUsd} — refused` }
    }
  }

  const record = {
    bsvUsd: n,
    fetchedAt: new Date().toISOString(),
    previous: prev ? prev.bsvUsd : null,
    ...meta
  }
  fs.writeFileSync(RATE_PATH, JSON.stringify(record, null, 2) + '\n')
  return { ok: true, record }
}

// Each agent process keeps its own rate fresh (direct, free). Used by agent-server.js
// and consumer-remote.js, where every container has its own rate.json.
async function ensureFreshRate(maxAgeMin = 60) {
  if (isStale(maxAgeMin)) {
    try {
      const { bsvUsd, sourceTime } = await fetchRateFromChain()
      saveRate(bsvUsd, { source: 'direct:whatsonchain', sourceTime }, { guard: false })
    } catch {
      // keep whatever we have; callers see the rate via getBsvUsd()
    }
  }
  return getBsvUsd()
}

module.exports = {
  RATE_PATH, getBsvUsd, readRate, isStale, describeRate,
  fetchRateFromChain, saveRate, ensureFreshRate
}
