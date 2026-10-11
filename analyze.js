// analyze.js
// Reads the run logs and prints the statistics an evaluation chapter needs.
//
//   node analyze.js                     ./runs.json (host runs), or ./state if there is no runs.json
//   node analyze.js --state state       container runs: state/consumer/runs.json + every seller's
//                                       state/<agent>/ledger-<agent>.jsonl, joined by txid
//   node analyze.js path/to/runs.json   any runs file
//   add --csv for one flat row per task (Excel / charts)
//
// In container runs the buyer only knows prices; what serving a task really cost (and
// so the margin and the cost-estimate error) is in the seller's own ledger, so those
// numbers come from joining the two on the payment's txid.
// Records written by older versions lack some fields; they are left out of the
// statistics that need them.

const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const wantCsv = args.includes('--csv')
const stateAt = args.indexOf('--state')
let stateDir = stateAt >= 0 ? args[stateAt + 1] : null
let file = args.filter((x, i) => !x.startsWith('--') && !(stateAt >= 0 && i === stateAt + 1))[0] || null

if (!file && !stateDir) {
  if (fs.existsSync('runs.json')) file = 'runs.json'
  else if (fs.existsSync(path.join('state', 'consumer', 'runs.json'))) stateDir = 'state'
}
if (stateDir && !file) file = path.join(stateDir, 'consumer', 'runs.json')
if (!file || !fs.existsSync(file)) {
  console.error(`${file || 'runs.json'} not found. Run node full-pipeline.js (host) or docker compose run --rm consumer (containers) first, from the project folder.`)
  process.exit(1)
}

function readJsonl(f) {
  const out = []; let bad = 0
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { bad++ }
  }
  return { rows: out, skipped: bad }
}
const { rows, skipped } = readJsonl(file)
const tasks = rows.filter(r => r.taskType)

// seller ledgers: <stateDir>/<agent>/ledger-<agent>.jsonl
const ledger = []
let ledgerSkipped = 0
if (stateDir && fs.existsSync(stateDir)) {
  for (const d of fs.readdirSync(stateDir)) {
    const dir = path.join(stateDir, d)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir)) {
      if (!/^ledger-.+\.jsonl$/.test(f)) continue
      const r = readJsonl(path.join(dir, f)); ledger.push(...r.rows); ledgerSkipped += r.skipped
    }
  }
}

// ---------- helpers ----------
const num = v => typeof v === 'number' && Number.isFinite(v)
const sum = a => a.reduce((x, y) => x + y, 0)
const mean = a => (a.length ? sum(a) / a.length : null)
const sd = a => {
  if (a.length < 2) return null
  const m = mean(a)
  return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1))
}
const sorted = a => [...a].sort((x, y) => x - y)
const median = a => {
  if (!a.length) return null
  const s = sorted(a), i = Math.floor(s.length / 2)
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2
}
const pct95 = a => (a.length ? sorted(a)[Math.max(0, Math.ceil(0.95 * a.length) - 1)] : null) // nearest rank
const f0 = v => (v === null || v === undefined ? '-' : Math.round(v).toLocaleString('en-US'))
const f1 = v => (v === null || v === undefined ? '-' : v.toFixed(1))
const pc = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-')
const signed = v => (v === null || v === undefined ? '-' : (v >= 0 ? '+' : '') + Math.round(v).toLocaleString('en-US'))
const groupBy = (arr, key) => arr.reduce((m, r) => { const k = key(r); (m[k] = m[k] || []).push(r); return m }, {})
const pad = (s, n) => String(s).padEnd(n)
const rpad = (s, n) => String(s).padStart(n)
const table = (head, body) => {
  const w = head.map((h, i) => Math.max(String(h).length, ...body.map(r => String(r[i]).length)))
  const fmt = r => r.map((c, i) => (i === 0 ? pad(c, w[i]) : rpad(c, w[i]))).join('  ')
  console.log('  ' + fmt(head)); console.log('  ' + w.map(x => '-'.repeat(x)).join('  '))
  body.forEach(r => console.log('  ' + fmt(r)))
}

// ---------- join buyer records with seller ledgers (container runs) ----------
const ledgerByTxid = new Map(ledger.filter(l => l.txid).map(l => [l.txid, l]))
const buyerTxids = new Set(tasks.filter(r => r.txid).map(r => r.txid))
for (const r of tasks) {
  if (r.mode !== 'remote' || !r.txid) continue
  const l = ledgerByTxid.get(r.txid)
  if (!l) { r.ledgerStatus = ledger.length ? 'missing' : undefined; continue }
  r.ledgerStatus = l.status
  if (l.status === 'delivered') {
    r.realAiCostSats = l.realCostSats; r.marginSats = l.marginSats; r.estCostSats = l.estCostSats
    if (num(l.realCostSats) && num(l.estCostSats)) r.estErrorSats = l.realCostSats - l.estCostSats
  } else if (l.status === 'paid-not-delivered') r.paidButNotDelivered = true
}

// ---------- CSV mode ----------
if (wantCsv) {
  const cols = ['timestamp', 'mode', 'traceId', 'ledgerStatus', 'taskType', 'winner', 'success', 'bsvUsd', 'budget', 'agreedPrice', 'rounds', 'estCostSats',
    'realAiCostSats', 'marginSats', 'estErrorSats', 'negotiationMs', 'paymentMs', 'verificationMs', 'serviceMs', 'totalMs', 'paidButNotDelivered']
  const val = r => [r.timestamp, r.mode || 'local', r.traceId, r.ledgerStatus, r.taskType, r.winner, r.success, r.bsvUsd, r.budget, r.agreedPrice, r.rounds, r.estCostSats,
    r.realAiCostSats, r.marginSats, r.estErrorSats, r.timings && r.timings.negotiationMs, r.timings && r.timings.paymentBuildBroadcastMs,
    r.timings && r.timings.verificationMs, r.timings && (r.timings.serviceCallMs ?? r.timings.aiCallMs), r.timings && r.timings.totalMs, r.paidButNotDelivered]
  const cell = v => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
  console.log(cols.join(','))
  tasks.forEach(r => console.log(val(r).map(cell).join(',')))
  process.exit(0)
}

// ---------- report ----------
if (!tasks.length) { console.log('No task records in', file); process.exit(0) }

const done = tasks.filter(r => r.success)
const noDeal = tasks.filter(r => !r.success && !r.txid)
const unverified = tasks.filter(r => !r.success && r.txid && !r.paidButNotDelivered)
const lost = tasks.filter(r => r.paidButNotDelivered)
const stamps = tasks.map(r => r.timestamp).filter(Boolean).sort()

console.log(`\n=== ${file}: ${tasks.length} tasks${stamps.length ? `, ${stamps[0].slice(0, 16)} .. ${stamps[stamps.length - 1].slice(0, 16)}` : ''}${skipped ? ` (${skipped} unreadable lines skipped)` : ''}${ledger.length ? `; ${ledger.length} seller ledger lines` : ''}${ledgerSkipped ? ` (${ledgerSkipped} unreadable)` : ''} ===\n`)

console.log('OUTCOMES')
table(['', 'n', 'share'], [
  ['completed', done.length, pc(done.length, tasks.length)],
  ['no deal (agent walked away, paid nothing)', noDeal.length, pc(noDeal.length, tasks.length)],
  ['paid, not delivered (verification or protocol error)', unverified.length, pc(unverified.length, tasks.length)],
  ['paid, service failed (no escrow)', lost.length, pc(lost.length, tasks.length)]
])

// money: split services that cost the provider real API money from free-upstream ones
const paid = done.filter(r => num(r.agreedPrice))
const costed = paid.filter(r => num(r.realAiCostSats) && r.realAiCostSats > 0)
const free = paid.filter(r => !(num(r.realAiCostSats) && r.realAiCostSats > 0))
console.log('\nMONEY (sats)')
table(['', 'tasks', 'paid', 'provider cost', 'margin', 'margin / task', 'at a loss'], [
  ['services with real API cost', costed.length, f0(sum(costed.map(r => r.agreedPrice))), f0(sum(costed.map(r => r.realAiCostSats))),
    signed(sum(costed.map(r => r.marginSats ?? r.agreedPrice - r.realAiCostSats))), signed(mean(costed.map(r => r.marginSats ?? r.agreedPrice - r.realAiCostSats))),
    costed.filter(r => (r.marginSats ?? r.agreedPrice - r.realAiCostSats) < 0).length],
  ['free-upstream services (rate)', free.length, f0(sum(free.map(r => r.agreedPrice))), '0', signed(sum(free.map(r => r.agreedPrice))), signed(mean(free.map(r => r.agreedPrice))), 0]
])

// by task type
console.log('\nBY TASK TYPE')
table(['type', 'tasks', 'completed', 'avg rounds', 'avg price', 'avg margin'],
  Object.entries(groupBy(tasks, r => r.taskType)).map(([t, rs]) => {
    const ok = rs.filter(r => r.success)
    return [t, rs.length, pc(ok.length, rs.length), f1(mean(ok.filter(r => num(r.rounds)).map(r => r.rounds))),
      f0(mean(ok.filter(r => num(r.agreedPrice)).map(r => r.agreedPrice))), signed(mean(ok.filter(r => num(r.marginSats)).map(r => r.marginSats)))]
  }))

// by winning provider: how good were its cost estimates?
const byProv = groupBy(done.filter(r => r.winner), r => r.winner)
console.log('\nBY PROVIDER (winner) — cost-estimate accuracy: estimate error = real cost - estimate')
table(['provider', 'wins', 'avg price', 'avg margin', 'worst margin', 'at a loss', 'est. error % (mean ± sd)'],
  Object.entries(byProv).map(([p, rs]) => {
    const errs = rs.filter(r => num(r.estErrorSats) && r.estCostSats > 0).map(r => (100 * r.estErrorSats) / r.estCostSats)
    const margins = rs.filter(r => num(r.marginSats)).map(r => r.marginSats)
    return [p, rs.length, f0(mean(rs.filter(r => num(r.agreedPrice)).map(r => r.agreedPrice))), signed(mean(margins)),
      margins.length ? signed(Math.min(...margins)) : '-', margins.filter(m => m < 0).length,
      errs.length ? `${f1(mean(errs))} ± ${errs.length > 1 ? f1(sd(errs)) : 'n/a'}  (n=${errs.length})` : '-']
  }))

// competition: price gap between cheapest and second-cheapest offer
const gaps = []
for (const r of tasks) {
  const offers = (r.negotiations || []).filter(n => num(n.price)).map(n => n.price).sort((a, b) => a - b)
  if (offers.length >= 2) gaps.push({ gap: offers[1] - offers[0], rel: (100 * (offers[1] - offers[0])) / offers[1] })
}
if (gaps.length) {
  console.log('\nCOMPETITION')
  console.log(`  ${gaps.length} tasks had two or more offers; the winner was on average ${f0(mean(gaps.map(g => g.gap)))} sats (${f1(mean(gaps.map(g => g.rel)))} %) cheaper than the runner-up.`)
}

// seller ledgers (container runs): each seller's own books
if (ledger.length) {
  console.log('\nSELLER LEDGERS (each seller\'s own books; the buyer never sees these)')
  table(['seller', 'delivered', 'paid, failed', 'revenue', 'real cost', 'margin', 'avg rounds', 'est. error % (mean ± sd)'],
    Object.entries(groupBy(ledger, l => l.agent || '?')).map(([a, ls]) => {
      const d = ls.filter(l => l.status === 'delivered')
      const errs = d.filter(l => num(l.realCostSats) && l.estCostSats > 0).map(l => (100 * (l.realCostSats - l.estCostSats)) / l.estCostSats)
      return [a, d.length, ls.filter(l => l.status === 'paid-not-delivered').length, f0(sum(d.map(l => l.price))), f0(sum(d.map(l => l.realCostSats || 0))),
        signed(sum(d.map(l => l.marginSats || 0))), f1(mean(d.filter(l => num(l.rounds)).map(l => l.rounds))),
        errs.length ? `${f1(mean(errs))} ± ${errs.length > 1 ? f1(sd(errs)) : 'n/a'}  (n=${errs.length})` : '-']
    }))
  const unbilled = tasks.filter(r => r.mode === 'remote' && r.txid && !ledgerByTxid.has(r.txid))
  if (unbilled.length) console.log(`  buyer paid ${unbilled.length} time(s), ${f0(sum(unbilled.map(r => r.agreedPrice || 0)))} sats in total, with no matching seller ledger line (paid, nothing delivered)`)
  const orphan = ledger.filter(l => l.txid && !buyerTxids.has(l.txid))
  if (orphan.length) console.log(`  ${orphan.length} seller ledger line(s) have no buyer record (another buyer, or a deleted runs.json)`)
}

// latency (completed tasks only), separately for host runs and container runs
function latencyTable(recs, title) {
  const get = k => recs.map(r => r.timings && r.timings[k]).filter(num)
  const svc = recs.map(r => r.timings && (r.timings.serviceCallMs ?? r.timings.aiCallMs)).filter(num)
  const row = (label, a) => [label, a.length, f0(median(a)), f0(pct95(a)), f0(a.length ? Math.max(...a) : null)]
  console.log(`\n${title}`)
  const body = [row('negotiation', get('negotiationMs')), row('payment build + broadcast', get('paymentBuildBroadcastMs'))]
  if (get('verificationMs').length) body.push(row('on-chain verification (0-conf, indexer latency)', get('verificationMs')))
  body.push(row(recs.some(r => r.mode === 'remote') ? 'service request (seller verifies payment + runs the service)' : 'service call', svc))
  body.push(row('TOTAL end-to-end', get('totalMs')))
  table(['stage', 'n', 'median', 'p95', 'max'], body)
}
const doneLocal = done.filter(r => r.mode !== 'remote'), doneRemote = done.filter(r => r.mode === 'remote')
if (doneLocal.length) latencyTable(doneLocal, `LATENCY, host runs (completed tasks, ms)`)
if (doneRemote.length) latencyTable(doneRemote, `LATENCY, container runs over HTTP (completed tasks, ms)`)
console.log('  (verification = when the payment became visible to the indexer, not block confirmation.)')

// rate purchases
const rateBuys = tasks.filter(r => r.taskType === 'rate' && r.success)
if (rateBuys.length) console.log(`\nRATE PURCHASES: ${rateBuys.length} bought from rate-bot for ${f0(sum(rateBuys.map(r => r.agreedPrice)))} sats in total; refused by the sanity guard: ${rateBuys.filter(r => r.rateUpdate && r.rateUpdate.refused).length}`)

console.log()
