require('dotenv').config()
// print-key.js
// Recovery tool: prints the payment address and private key (WIF) of one
// print job, so any payments sitting at that address can be spent from any
// wallet that imports a WIF. Anyone who sees this key can spend the funds.
//
//   node print-key.js <jobId>

const { jobKey, jobAddress } = require('./invoice')

const jobId = process.argv[2]
if (!jobId || !/^[0-9a-f]{12}$/.test(jobId)) { console.error('Usage: node print-key.js <jobId>   (12 hex characters, see print-jobs/jobs.json)'); process.exit(1) }
if (!process.env.PRINTER_MASTER_WIF) { console.error('PRINTER_MASTER_WIF missing from .env'); process.exit(1) }

console.log(`job ${jobId}`)
console.log(`testnet address: ${jobAddress(process.env.PRINTER_MASTER_WIF, jobId, 'test')}`)
console.log(`mainnet address: ${jobAddress(process.env.PRINTER_MASTER_WIF, jobId, 'main')}`)
console.log(`private key (WIF, keep secret): ${jobKey(process.env.PRINTER_MASTER_WIF, jobId).toWif()}`)
