// payment.js
// Builds, signs, and broadcasts a real BSV testnet payment. UTXOs come from
// the chain indexer (confirmed + unconfirmed, minus outputs already spent in
// the mempool — see chain.js), corrected by what this wallet itself knows.
//
// Why the extra local bookkeeping: the indexer can lag a few seconds behind
// our own broadcasts, so it may still offer coins we just spent (a second
// payment would then be rejected as `txn-mempool-conflict`, i.e. a
// double-spend) and may not list our change output yet. So we remember what
// we spent and the change we created in memory, and merge that with the
// indexer's list.
//
// Our own transactions are also saved to wallet-txs.json. Spending an
// unconfirmed change output needs its parent transaction, and the API does
// not always serve unconfirmed transactions right away, so a later run
// (another process) reads the parent from that file instead of waiting.

const fs = require('fs')
const path = require('path')
const { PrivateKey, Transaction, P2PKH } = require('@bsv/sdk')
const { getUnspent, getRawTxHex, broadcastTx } = require('./chain')

const TX_STORE_PATH = path.join(process.env.STATE_DIR || __dirname, 'wallet-txs.json')
const TX_STORE_MAX = 25 // keep the most recent transactions only

function loadTxStore() {
  try {
    return JSON.parse(fs.readFileSync(TX_STORE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

// Raw transactions are immutable facts, so unlike spent/unspent state this
// can never go stale or wrong.
function rememberTx(txid, hex) {
  const store = loadTxStore()
  store[txid] = hex
  const ids = Object.keys(store)
  ids.slice(0, Math.max(0, ids.length - TX_STORE_MAX)).forEach(id => delete store[id])
  try {
    fs.writeFileSync(TX_STORE_PATH, JSON.stringify(store))
  } catch {
    // best effort: worst case the next run fetches the parent from the API
  }
}

const spentOutpoints = new Set()   // "txid:vout" we have already spent
const pendingOutputs = new Map()   // "txid:vout" -> our own not-yet-indexed change output

const outpoint = (txid, vout) => `${txid}:${vout}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The coin list can be fetched ahead of time (e.g. while the buyer is still negotiating),
// so the payment itself only has to sign and broadcast. Used once, and only if fresh.
const PREFETCH_MAX_AGE_MS = 30000
let prefetched = null // { address, promise, startedAt }

// Skipped when the wallet's own known coins already cover a typical payment: then the
// payment won't ask the indexer at all (see payProvider), so a lookup would be wasted.
const PREFETCH_SKIP_SATS = 20000

function prefetchSpendable(consumerWif) {
  const address = PrivateKey.fromWif(consumerWif).toPublicKey().toAddress('testnet').toString()
  const ownSats = localOutputs(address).reduce((a, u) => a + u.value, 0)
  if (ownSats >= PREFETCH_SKIP_SATS) { prefetched = null; return Promise.resolve(null) }
  const promise = getUnspent(address)
  promise.catch(() => {}) // a failed prefetch only means the payment fetches again
  prefetched = { address, promise, startedAt: Date.now() }
  return promise
}

async function takePrefetched(address) {
  const p = prefetched
  prefetched = null
  if (!p || p.address !== address || Date.now() - p.startedAt > PREFETCH_MAX_AGE_MS) return null
  try { return await p.promise } catch { return null }
}

// What our own saved transactions say: every input of ours is a spent coin, and every
// output to our address that none of them spends is our coin. This survives process
// restarts (each container run is a new process), so a new run doesn't re-pick a coin the
// previous run spent just because the indexer hasn't caught up yet. (Re-picking it would
// rebuild a byte-identical payment, which the network rejects as "already in the mempool".)
function storeView(myScriptHex) {
  const spent = new Set()
  const outs = new Map()
  for (const [id, hex] of Object.entries(loadTxStore())) {
    let tx
    try { tx = Transaction.fromHex(hex) } catch { continue }
    tx.inputs.forEach(i => spent.add(outpoint(i.sourceTXID, i.sourceOutputIndex)))
    tx.outputs.forEach((o, vout) => {
      if (o.satoshis > 0 && o.lockingScript.toHex() === myScriptHex) outs.set(outpoint(id, vout), { txid: id, vout, value: o.satoshis, tx })
    })
  }
  for (const k of spent) outs.delete(k)
  return { spent, outs }
}

// Our own unspent coins as far as this wallet knows (memory + saved transactions), no network.
function localOutputs(address) {
  const local = storeView(new P2PKH().lock(address).toHex())
  const isSpent = k => spentOutpoints.has(k) || local.spent.has(k)
  const pool = new Map()
  for (const [k, p] of [...pendingOutputs, ...local.outs]) if (!isSpent(k) && !pool.has(k)) pool.set(k, p)
  return [...pool.values()].sort((a, b) => b.value - a.value)
}

// Indexer UTXOs minus what we know is spent, plus our own change the indexer doesn't
// list yet. Largest first, so fewer inputs (= smaller fee).
async function spendableOutputs(address, indexed = null) {
  const local = storeView(new P2PKH().lock(address).toHex())
  const isSpent = k => spentOutpoints.has(k) || local.spent.has(k)
  const pool = new Map()
  for (const u of indexed || await getUnspent(address)) {
    const k = outpoint(u.tx_hash, u.tx_pos)
    if (isSpent(k)) continue
    const known = pendingOutputs.get(k) || local.outs.get(k)
    pool.set(k, { txid: u.tx_hash, vout: u.tx_pos, value: u.value, tx: known ? known.tx : null })
  }
  for (const [k, p] of [...pendingOutputs, ...local.outs]) {
    if (!isSpent(k) && !pool.has(k)) pool.set(k, p)
  }
  return [...pool.values()].sort((a, b) => b.value - a.value)
}

async function buildPayment(priv, providerAddress, amountSats, utxos) {
  const changeAddress = priv.toPublicKey().toAddress('testnet')
  const tx = new Transaction()
  const used = []
  const stored = loadTxStore()
  let totalIn = 0

  for (const u of utxos) {
    // The SDK needs the full source transaction (not just the amount) to
    // compute fees. Look in memory, then in our saved transactions, and only
    // then ask the API.
    const sourceTransaction =
      u.tx || (stored[u.txid] ? Transaction.fromHex(stored[u.txid]) : Transaction.fromHex(await getRawTxHex(u.txid)))
    tx.addInput({
      sourceTransaction,
      sourceOutputIndex: u.vout,
      unlockingScriptTemplate: new P2PKH().unlock(priv)
    })
    used.push(u)
    totalIn += u.value
    if (totalIn >= amountSats + 500) break // rough fee buffer
  }

  if (totalIn < amountSats) {
    throw new Error(`Insufficient funds: have ${totalIn} sats, need ${amountSats}+fee.`)
  }

  tx.addOutput({ lockingScript: new P2PKH().lock(providerAddress), satoshis: amountSats })
  tx.addOutput({ lockingScript: new P2PKH().lock(changeAddress), change: true })

  await tx.fee()
  await tx.sign()
  return { tx, used }
}

async function payProvider(consumerWif, providerAddress, amountSats, { attempts = 3, retryDelayMs = 3000 } = {}) {
  const priv = PrivateKey.fromWif(consumerWif)
  const myAddress = priv.toPublicKey().toAddress('testnet').toString()

  for (let attempt = 1; ; attempt++) {
    // Local first: our own change from the previous payment is usually enough, and using it
    // directly saves a round trip to the indexer. The indexer is asked only when our own
    // coins don't cover the payment, and always on a retry (if the network rejected a coin
    // we thought was ours, we need its view, not ours).
    let utxos = null
    if (attempt === 1) {
      const own = localOutputs(myAddress)
      if (own.reduce((a, u) => a + u.value, 0) >= amountSats + 500) { utxos = own; prefetched = null }
    }
    if (!utxos) {
      const indexed = attempt === 1 ? await takePrefetched(myAddress) : null
      utxos = await spendableOutputs(myAddress, indexed)
    }
    if (utxos.length === 0) {
      throw new Error(spentOutpoints.size
        ? 'Wallet view out of sync: the network says every coin this wallet knows is already spent. Wait a minute for the indexer to catch up and try again.'
        : `No funded UTXOs for ${myAddress} — fund it via a testnet faucet first.`)
    }

    const { tx, used } = await buildPayment(priv, providerAddress, amountSats, utxos)
    const txHex = tx.toHex()

    try {
      const txid = await broadcastTx(txHex)

      // Book-keeping only after the network accepted the transaction.
      used.forEach(u => spentOutpoints.add(outpoint(u.txid, u.vout)))
      const change = tx.outputs[1]
      if (change && change.satoshis > 0) {
        const id = tx.id('hex')
        // Re-parse so we don't keep the whole chain of source transactions alive.
        pendingOutputs.set(outpoint(id, 1), { txid: id, vout: 1, value: change.satoshis, tx: Transaction.fromHex(txHex) })
        rememberTx(id, txHex)
      }
      return { txid, txHex }
    } catch (err) {
      // Conflict with a transaction the indexer hadn't shown us yet (e.g. from
      // a run seconds ago in another process): give it time to catch up, retry.
      const outOfSync = /mempool-conflict|missing.?inputs|already in the mempool|txn-already-known|already known/i.test(err.message)
      if (!outOfSync || attempt >= attempts) throw err
      used.forEach(u => spentOutpoints.add(outpoint(u.txid, u.vout))) // the network says these coins are taken
      console.log(`[payment] Wallet view out of sync with the network (attempt ${attempt}/${attempts}) — retrying in ${retryDelayMs / 1000} s...`)
      await sleep(retryDelayMs)
    }
  }
}

module.exports = { payProvider, prefetchSpendable }
