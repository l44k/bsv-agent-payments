// pricing.js
// Converts USD amounts (real Claude API costs, provider prices, consumer
// budgets) into satoshis at the CURRENT cached BSV/USD rate (see rate.js).

const { getBsvUsd } = require('./rate')

// Claude Haiku 4.5 pricing (per million tokens). Update if pricing changes —
// check https://docs.claude.com/en/docs/about-claude/pricing for current rates.
const HAIKU_PRICE_PER_MTOK_IN = 1.0   // USD
const HAIKU_PRICE_PER_MTOK_OUT = 5.0  // USD

function satsPerUsd() {
  return 100_000_000 / getBsvUsd()
}

function usdCostOfCall(inputTokens, outputTokens) {
  const inCost = (inputTokens / 1_000_000) * HAIKU_PRICE_PER_MTOK_IN
  const outCost = (outputTokens / 1_000_000) * HAIKU_PRICE_PER_MTOK_OUT
  return inCost + outCost
}

// Measured costs round UP so a real cost is never understated.
function usdToSats(usd) {
  return Math.ceil(usd * satsPerUsd())
}

// Prices and budgets round to nearest.
function quoteSats(usd) {
  return Math.round(usd * satsPerUsd())
}

// Rough token count (about 4 characters per token for English text). Good
// enough for a provider to estimate what a request will cost before it runs.
function estimateTokens(text) {
  return Math.ceil(String(text).length / 4)
}

// sats -> USD at a given BSV/USD rate (default: the current cached rate)
function satsToUsd(sats, bsvUsd = getBsvUsd()) {
  return (sats * bsvUsd) / 100_000_000
}

// Micropayments are fractions of a cent, so show enough decimals to see two
// significant digits: $0.00097, $0.000013, $1.50.
function formatUsd(usd) {
  if (!Number.isFinite(usd)) return '-'
  if (usd === 0) return '$0'
  const decimals = Math.min(10, Math.max(2, Math.ceil(-Math.log10(Math.abs(usd))) + 1))
  return `$${usd.toFixed(decimals)}`
}

module.exports = { usdCostOfCall, usdToSats, quoteSats, satsPerUsd, getBsvUsd, estimateTokens, satsToUsd, formatUsd }
