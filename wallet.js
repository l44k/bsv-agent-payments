// wallet.js
// Generates a keypair for an agent. Run once per agent, save the output.
const { PrivateKey } = require('@bsv/sdk')

function newAgentWallet(label) {
  const priv = PrivateKey.fromRandom()
  const pub = priv.toPublicKey()
  const address = pub.toAddress('testnet') // explicitly testnet (SDK defaults to mainnet)

  console.log(`\n--- ${label} wallet ---`)
  console.log('WIF (private key, keep secret):', priv.toWif())
  console.log('Address (fund this with testnet coins):', address.toString())
  return { priv, pub, address }
}

if (require.main === module) {
  newAgentWallet('PROVIDER')
  newAgentWallet('CONSUMER')
  console.log(`
Next steps:
1. Copy each WIF into provider.js / consumer.js
2. Fund the PROVIDER address a little is fine (not required to sell)
3. Fund the CONSUMER address using a BSV testnet faucet, e.g.:
   https://witnessonchain.com/faucet/tbsv
4. Run: node provider.js   (in one terminal)
5. Run: node consumer.js   (in another terminal)
`)
}

module.exports = { newAgentWallet }
