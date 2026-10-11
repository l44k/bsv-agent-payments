// invoice.js
// Pricing and payment addresses for the print shop.
//
// Every print job gets its own payment address, derived (BRC-42) from one
// master key and the job id. A payment to that address can only mean that job,
// so the payer never has to identify themselves, and all the money stays
// recoverable from the master key alone: the key of any job is
// master.deriveChild(master.toPublicKey(), 'print-<jobId>'), see print-key.js.

const { PrivateKey } = require('@bsv/sdk')
const { quoteSats } = require('./pricing')

const PAGES_PER_STEP = 5 // "10 cents per 1-5 pages": every started block of 5 pages costs one step

// USD price for a document: one step per started block of 5 pages.
function priceUsd(pages, usdPerStep) {
  if (!Number.isInteger(pages) || pages < 1) throw new Error('pages must be a whole number >= 1')
  return Math.round(usdPerStep * Math.ceil(pages / PAGES_PER_STEP) * 1e6) / 1e6
}

// USD -> sats at the current cached BSV/USD rate (rate.js).
function quote(pages, usdPerStep) {
  const usd = priceUsd(pages, usdPerStep)
  return { usd, sats: Math.max(1, quoteSats(usd)) }
}

function jobKey(masterWif, jobId) {
  const master = PrivateKey.fromWif(masterWif)
  return master.deriveChild(master.toPublicKey(), `print-${jobId}`)
}

// network: 'test' (testnet address, starts with m/n) or 'main' (starts with 1)
function jobAddress(masterWif, jobId, network = 'test') {
  const pub = jobKey(masterWif, jobId).toPublicKey()
  return (network === 'main' ? pub.toAddress() : pub.toAddress('testnet')).toString()
}

module.exports = { PAGES_PER_STEP, priceUsd, quote, jobKey, jobAddress }
