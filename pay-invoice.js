require('dotenv').config()
// pay-invoice.js
// Testnet helper: pays a print job's invoice from your CONSUMER wallet, as a
// customer's phone wallet would on mainnet.
//
//   node pay-invoice.js <testnet-address> <sats>
//
// Refuses amounts above 1 000 000 sats unless you add --force (a typo guard).

const { payProvider } = require('./payment')

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const force = process.argv.includes('--force')
const [address, satsText] = args
const sats = Number(satsText)

if (!address || !/^[mn][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)) {
  console.error('Usage: node pay-invoice.js <testnet address starting with m or n> <sats>')
  process.exit(1)
}
if (!Number.isInteger(sats) || sats < 1) { console.error('sats must be a whole number >= 1'); process.exit(1) }
if (sats > 1000000 && !force) { console.error(`${sats} sats is a lot for a testnet wallet; add --force if you mean it.`); process.exit(1) }
if (!process.env.CONSUMER_WIF) { console.error('CONSUMER_WIF missing from .env'); process.exit(1) }

payProvider(process.env.CONSUMER_WIF, address, sats)
  .then(r => console.log(`Paid ${sats} sats to ${address}\ntxid: ${r.txid}`))
  .catch(err => { console.error(`Payment failed: ${err.message}`); process.exit(1) })
