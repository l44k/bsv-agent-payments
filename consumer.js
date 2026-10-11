// consumer.js
// The "buyer" agent. Builds and signs a payment transaction, sends it to
// the provider's address, and requests the service.

const { PrivateKey, Transaction, P2PKH } = require('@bsv/sdk')
const { handleRequest, address: providerAddress, PRICE_SATS } = require('./provider')

// --- CONFIG: paste your CONSUMER wallet from `node wallet.js` here ---
const CONSUMER_WIF = 'PASTE_CONSUMER_WIF_HERE'

// --- CONFIG: a funded UTXO belonging to the consumer address ---
// In production the agent queries this itself (WhatsOnChain "unspent" endpoint).
// For this demo, fill in one UTXO you funded via the testnet faucet.
const UTXO = {
  txid: 'PASTE_FUNDING_TXID',
  vout: 0,
  satoshis: 1000, // whatever the faucet gave you
  scriptPubKeyHex: 'PASTE_LOCKING_SCRIPT_HEX' // from the funding tx output
}

const priv = PrivateKey.fromWif(CONSUMER_WIF)

async function payAndRequest() {
  console.log(`[consumer] Building payment of ${PRICE_SATS} sats to ${providerAddress}...`)

  const tx = new Transaction()

  tx.addInput({
    sourceTXID: UTXO.txid,
    sourceOutputIndex: UTXO.vout,
    unlockingScriptTemplate: new P2PKH().unlock(priv),
    sourceSatoshis: UTXO.satoshis
  })

  tx.addOutput({
    lockingScript: new P2PKH().lock(providerAddress),
    satoshis: PRICE_SATS
  })

  // change back to self
  tx.addOutput({
    lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress('testnet')),
    change: true
  })

  await tx.fee()
  await tx.sign()

  const txHex = tx.toHex()
  console.log(`[consumer] Signed tx: ${txHex.slice(0, 40)}... (${txHex.length / 2} bytes)`)

  // A real agent broadcasts this itself, e.g. via WhatsOnChain broadcast API,
  // then hands the txid/hex to the provider as proof of payment.
  console.log('[consumer] Sending payment proof to provider and requesting service...')

  const result = await handleRequest(txHex)

  if (result) {
    console.log(`[consumer] Got service result: "${result}"`)
  } else {
    console.log('[consumer] Request failed.')
  }
}

payAndRequest().catch(console.error)
