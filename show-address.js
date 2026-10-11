// show-address.js
// Prints the testnet address for the CONSUMER_WIF in your .env — use this
// whenever you need the address again to fund it or check its balance.
require('dotenv').config()
const { PrivateKey } = require('@bsv/sdk')

const wif = process.env.CONSUMER_WIF
if (!wif) {
  console.error('CONSUMER_WIF not found in .env')
  process.exit(1)
}

const address = PrivateKey.fromWif(wif).toPublicKey().toAddress('testnet').toString()
console.log('CONSUMER address (fund this one):', address)
