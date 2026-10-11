require('dotenv').config()
// print-shop.js
// A pay-per-print service: a customer uploads a PDF in the browser, gets a
// price ($0.10 per started block of 5 pages by default, converted to sats at
// the current BSV/USD rate) and a payment address that belongs to that one
// job. When the payment shows up, the PDF is printed. Nothing is printed
// before it is paid, and nothing runs by itself except watching the addresses
// of jobs that are waiting for payment.
//
//   node print-shop.js --init    once: creates PRINTER_MASTER_WIF in .env
//   node print-shop.js           start the shop, open the printed address in a browser
//
// .env options (all optional):
//   PRINT_MODE=dry|real         dry = copy to printed/ instead of printing (default)
//   PRINTER_NAME=               printer to use in real mode (default printer if empty)
//   PRINT_NETWORK=test|main     test = testnet coins (no value, default); main = REAL money
//   PRINT_PRICE_USD=0.10        price per started block of 5 pages
//   PRINT_MAX_PAGES=50   PRINT_MAX_MB=10   PRINT_QUOTE_MIN=15   PRINT_MIN_CONF=0
//   PRINT_PORT=3100   PRINT_HOST=0.0.0.0
//
// Payment is accepted as soon as it is visible on the network (0-conf,
// PRINT_MIN_CONF=0). The payer could still double-spend it afterwards; for
// cents that is an acceptable risk, for bigger amounts set PRINT_MIN_CONF=1.

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const { PrivateKey } = require('@bsv/sdk')
const { getUnspent } = require('./chain')
const { isStale, fetchRateFromChain, saveRate, getBsvUsd, describeRate } = require('./rate')
const { quote, jobAddress } = require('./invoice')
const { countPages, printPdf } = require('./printing')

const PAGE = `<!DOCTYPE html>
<html lang="fi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tulostin</title>
<style>
body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f3f4f6;color:#1f2937}
#wrap{max-width:560px;margin:0 auto;padding:20px}
h1{font-size:26px;margin:.2em 0}
.card{background:#fff;border-radius:10px;padding:16px;margin:14px 0;box-shadow:0 1px 3px rgba(0,0,0,.15)}
#banner{background:#fde68a;border-radius:8px;padding:8px 12px;margin:10px 0;font-size:14px}
button{font-size:18px;padding:.55em 1.2em;border:0;border-radius:8px;background:#2563eb;color:#fff;margin-top:10px}
button[disabled]{opacity:.5}
code,#addr{font-family:monospace;word-break:break-all;background:#eef2ff;padding:2px 5px;border-radius:4px}
#status{font-size:20px;font-weight:bold;margin:.6em 0}
.small{font-size:14px;opacity:.8}
.ok{color:#15803d}.bad{color:#b91c1c}
</style></head><body><div id="wrap">
<h1>Tulostin</h1>
<div id="price" class="small">...</div>
<div id="banner" style="display:none"></div>
<div class="card" id="pick">
  <div>1. Valitse PDF-tiedosto</div>
  <input type="file" id="file" accept="application/pdf,.pdf">
  <div><button id="quoteBtn" type="button" disabled>Hae hinta ja maksuosoite</button></div>
  <div id="pickErr" class="bad"></div>
</div>
<div class="card" id="jobCard" style="display:none">
  <div id="jobInfo"></div>
  <div style="margin-top:10px">Maksa täsmälleen <b id="sats"></b> sats (<span id="bsv"></span> BSV) osoitteeseen:</div>
  <div style="margin:6px 0"><span id="addr"></span></div>
  <div id="hint" class="small"></div>
  <div id="status"></div>
  <div id="left" class="small"></div>
  <button id="retryBtn" type="button" style="display:none">Yritä tulostusta uudelleen</button>
</div>
<div class="small">Tulostus alkaa heti kun maksu näkyy verkossa. Ylimaksua ei palauteta.</div>
</div>
<script>
(function () {
  var jobId = null, timer = null;
  function $(id) { return document.getElementById(id); }
  function grp(n) { return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' '); }
  function req(method, url, body, cb) {
    var x = new XMLHttpRequest();
    x.open(method, url, true);
    if (body) { x.setRequestHeader('Content-Type', 'application/pdf'); }
    x.onreadystatechange = function () {
      if (x.readyState !== 4) { return; }
      var d = null;
      try { d = JSON.parse(x.responseText); } catch (e) { d = null; }
      cb(x.status, d);
    };
    x.send(body || null);
  }

  var ERR = {
    'not-a-pdf': 'Tiedosto ei ole PDF.',
    'unreadable-pdf': 'PDF:ää ei voitu lukea (vioittunut tai salasanasuojattu).',
    'too-many-pages': 'Liikaa sivuja.',
    'too-large': 'Tiedosto on liian suuri.',
    'empty': 'Tiedosto on tyhjä.',
    'rate-unavailable': 'Kurssia ei saatu juuri nyt, yritä hetken päästä.'
  };

  req('GET', '/api/config', null, function (s, c) {
    if (s !== 200 || !c) { return; }
    if (c.satsPerStep === null) {
      $('price').textContent = '$' + c.usdPerStep.toFixed(2) + ' per alkava ' + c.pagesPerStep + ' sivua. BSV-kurssia ei saatu juuri nyt, hinta näkyy tarjouksessa kun kurssi on saatavilla.';
    } else {
      $('price').textContent = '$' + c.usdPerStep.toFixed(2) + ' per alkava ' + c.pagesPerStep + ' sivua \\u2248 ' + grp(c.satsPerStep) + ' sats (kurssi $' + c.bsvUsd + '/BSV). Enintään ' + c.maxPages + ' sivua.';
    }
    var notes = [];
    if (c.network === 'test') { notes.push('TESTNET: kolikoilla ei ole arvoa, ei oikeaa rahaa.'); }
    if (c.network === 'main') { notes.push('OIKEAA RAHAA (mainnet).'); }
    if (c.mode === 'dry') { notes.push('Koetila: tulostusta ei lähetetä oikealle tulostimelle.'); }
    if (notes.length) { $('banner').textContent = notes.join(' '); $('banner').style.display = 'block'; }
  });

  $('file').onchange = function () { $('quoteBtn').disabled = !($('file').files && $('file').files.length); $('pickErr').textContent = ''; };

  $('quoteBtn').onclick = function () {
    var f = $('file').files && $('file').files[0];
    if (!f) { return; }
    $('quoteBtn').disabled = true; $('pickErr').textContent = '';
    req('POST', '/api/quote', f, function (s, d) {
      $('quoteBtn').disabled = false;
      if (s !== 200 || !d) { $('pickErr').textContent = (d && ERR[d.error]) || 'Hinnan haku epäonnistui.'; return; }
      jobId = d.id;
      $('jobCard').style.display = 'block';
      $('jobInfo').textContent = d.pages + ' sivua \\u00B7 $' + d.usd.toFixed(2);
      $('sats').textContent = grp(d.sats);
      $('bsv').textContent = d.bsv.toFixed(8);
      $('addr').textContent = d.address;
      $('hint').textContent = d.network === 'test' ? 'Testnet: maksa komennolla  node pay-invoice.js ' + d.address + ' ' + d.sats : '';
      $('retryBtn').style.display = 'none';
      if (timer) { clearInterval(timer); }
      timer = setInterval(poll, 2000);
      poll();
    });
  };

  function mmss(sec) { var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }

  function poll() {
    if (!jobId) { return; }
    req('GET', '/api/job/' + jobId, null, function (s, j) {
      if (s !== 200 || !j) { return; }
      var st = $('status'), left = $('left');
      st.className = '';
      $('retryBtn').style.display = 'none';
      if (j.status === 'awaiting-payment') {
        st.textContent = 'Odotetaan maksua...' + (j.receivedSats ? ' (saatu ' + grp(j.receivedSats) + ' / ' + grp(j.sats) + ' sats)' : '');
        left.textContent = 'Hinta on voimassa ' + mmss(j.secondsLeft);
      } else if (j.status === 'printing') {
        st.textContent = 'Maksu vastaanotettu, tulostetaan...'; left.textContent = '';
      } else if (j.status === 'done') {
        st.textContent = 'Valmis! Nouda tulosteet.'; st.className = 'ok';
        left.textContent = j.overpaidSats ? 'Maksoit ' + grp(j.overpaidSats) + ' sats liikaa (ei palauteta).' : ''; clearInterval(timer);
      } else if (j.status === 'print-failed') {
        st.textContent = 'Tulostus epäonnistui, mutta maksu on kuitattu.'; st.className = 'bad';
        left.textContent = j.error || ''; $('retryBtn').style.display = 'inline-block'; clearInterval(timer);
      } else if (j.status === 'expired') {
        st.textContent = 'Hinta vanheni ennen maksua. Hae uusi hinta.'; st.className = 'bad'; left.textContent = ''; clearInterval(timer);
      }
    });
  }

  $('retryBtn').onclick = function () {
    if (!jobId) { return; }
    $('retryBtn').disabled = true;
    req('POST', '/api/job/' + jobId + '/retry', null, function () { $('retryBtn').disabled = false; timer = setInterval(poll, 2000); poll(); });
  };
}());
</script></body></html>`

const num = (v, fallback) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback)
const ID_RE = /^[0-9a-f]{12}$/

// Everything that touches the outside world is injectable so the shop can be
// tested without a chain, a printer or a clock: unspentFn, printFn, rateFetch, now.
function createShop(opts = {}) {
  const cfg = {
    masterWif: opts.masterWif || process.env.PRINTER_MASTER_WIF,
    network: opts.network || process.env.PRINT_NETWORK || 'test',
    usdPerStep: num(opts.usdPerStep, num(process.env.PRINT_PRICE_USD, 0.1)),
    maxPages: num(opts.maxPages, num(process.env.PRINT_MAX_PAGES, 50)),
    maxBytes: num(opts.maxMb, num(process.env.PRINT_MAX_MB, 10)) * 1024 * 1024,
    quoteMs: num(opts.quoteMin, num(process.env.PRINT_QUOTE_MIN, 15)) * 60000,
    minConf: num(opts.minConf, num(process.env.PRINT_MIN_CONF, 0)),
    mode: opts.mode || process.env.PRINT_MODE || 'dry',
    rateMaxAgeMin: num(opts.rateMaxAgeMin, 10),
    pollMs: num(opts.pollMs, 3000),
    dir: opts.dir || path.join(__dirname, 'print-jobs'),
    now: opts.now || Date.now,
    unspentFn: opts.unspentFn || getUnspent,
    printFn: opts.printFn || ((file, o) => printPdf(file, o)),
    rateFetch: opts.rateFetch || fetchRateFromChain
  }
  if (!cfg.masterWif) throw new Error('PRINTER_MASTER_WIF missing — run: node print-shop.js --init')
  PrivateKey.fromWif(cfg.masterWif) // throws early on a malformed key
  if (cfg.network !== 'test' && cfg.network !== 'main') throw new Error(`PRINT_NETWORK must be test or main, not ${cfg.network}`)

  fs.mkdirSync(cfg.dir, { recursive: true })
  const jobsPath = path.join(cfg.dir, 'jobs.json')
  const logPath = path.join(cfg.dir, 'log.jsonl')
  let jobs = {}
  try { jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8')) } catch { /* first start */ }

  const fileOf = j => path.join(cfg.dir, `${j.id}.pdf`)
  const save = () => { const tmp = `${jobsPath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(jobs)); fs.renameSync(tmp, jobsPath) }
  const rmFile = j => { try { fs.rmSync(fileOf(j), { force: true }) } catch { /* ignore */ } }
  const logFinal = j => fs.appendFileSync(logPath, JSON.stringify({
    id: j.id, status: j.status, pages: j.pages, usd: j.usd, sats: j.sats, bsvUsd: j.bsvUsd, network: j.network,
    receivedSats: j.receivedSats, createdAt: j.createdAt, paidAt: j.paidAt || null, printedAt: j.printedAt || null, error: j.error || null
  }) + '\n')

  // Housekeeping at start: a crash mid-print leaves 'printing' (retry is offered), and old documents are deleted.
  for (const j of Object.values(jobs)) {
    if (j.status === 'printing') { j.status = 'print-failed'; j.error = 'palvelin käynnistyi uudelleen kesken tulostuksen' }
    if (cfg.now() - j.createdAt > 48 * 3600 * 1000) rmFile(j)
  }
  save()

  function view(j) {
    return {
      id: j.id, status: j.status, pages: j.pages, usd: j.usd, sats: j.sats, bsv: j.sats / 1e8, bsvUsd: j.bsvUsd,
      address: j.address, network: j.network, receivedSats: j.receivedSats,
      missingSats: Math.max(0, j.sats - j.receivedSats), overpaidSats: Math.max(0, j.receivedSats - j.sats),
      secondsLeft: Math.max(0, Math.ceil((j.expiresAt - cfg.now()) / 1000)), error: j.error || null
    }
  }

  // Quotes must not be priced from an old or made-up rate: refresh it (free, direct) when stale, and refuse if there is none.
  async function ensureRate() {
    if (isStale(cfg.rateMaxAgeMin)) {
      try {
        const { bsvUsd, sourceTime } = await cfg.rateFetch()
        saveRate(bsvUsd, { source: 'direct:whatsonchain (print-shop)', sourceTime }, { guard: false })
      } catch { /* fall through to the age check */ }
    }
    if (isStale(24 * 60)) throw Object.assign(new Error('rate-unavailable'), { code: 503 })
  }

  async function doPrint(j) {
    try {
      await cfg.printFn(fileOf(j), { pages: j.pages }) // limited to the pages that were paid for
      j.status = 'done'; j.printedAt = cfg.now(); j.error = null
      rmFile(j) // documents are deleted as soon as they are printed
    } catch (err) {
      j.status = 'print-failed'; j.error = err.message
    }
    save(); logFinal(j)
  }

  let polling = false
  async function pollOnce() {
    if (polling) return // ticks never overlap, so a job is never printed twice
    polling = true
    try {
      for (const j of Object.values(jobs)) {
        if (j.status !== 'awaiting-payment') continue
        try {
          const utxos = await cfg.unspentFn(j.address, j.network)
          const received = utxos.filter(u => cfg.minConf === 0 || u.height > 0).reduce((a, u) => a + u.value, 0)
          if (received !== j.receivedSats) { j.receivedSats = received; save() }
          if (received >= j.sats) {
            j.status = 'printing'; j.paidAt = cfg.now(); save()
            await doPrint(j)
          } else if (cfg.now() >= j.expiresAt) {
            j.status = 'expired'; rmFile(j); save(); logFinal(j)
          }
        } catch (err) {
          console.log(`[shop] job ${j.id}: could not check payment (${err.message}), trying again`)
        }
      }
    } finally {
      polling = false
    }
  }

  const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body) }
  const sendJson = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj))

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > cfg.maxBytes) return reject(Object.assign(new Error('too-large'), { code: 413 }))
      const chunks = []; let n = 0
      req.on('data', c => {
        n += c.length
        if (n > cfg.maxBytes) { reject(Object.assign(new Error('too-large'), { code: 413 })); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  async function handle(req, res) {
    const url = (req.url || '/').split('?')[0]

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) return send(res, 200, 'text/html; charset=utf-8', PAGE)

    if (req.method === 'GET' && url === '/api/config') {
      const base = { usdPerStep: cfg.usdPerStep, pagesPerStep: 5, maxPages: cfg.maxPages, network: cfg.network, mode: cfg.mode }
      // the displayed price must come from a fresh rate too, never from the built-in fallback
      try { await ensureRate() } catch { return sendJson(res, 200, { ...base, satsPerStep: null, bsvUsd: null }) }
      return sendJson(res, 200, { ...base, satsPerStep: quote(5, cfg.usdPerStep).sats, bsvUsd: getBsvUsd() })
    }

    if (req.method === 'POST' && url === '/api/quote') {
      let body
      try { body = await readBody(req) } catch (err) { return sendJson(res, err.code || 400, { error: err.message }) }
      if (!body.length) return sendJson(res, 400, { error: 'empty' })
      let pages
      try { pages = await countPages(body) } catch (err) { return sendJson(res, 400, { error: err.message }) }
      if (pages > cfg.maxPages) return sendJson(res, 400, { error: 'too-many-pages', maxPages: cfg.maxPages })
      try { await ensureRate() } catch (err) { return sendJson(res, err.code || 503, { error: err.message }) }

      const id = crypto.randomBytes(6).toString('hex')
      const q = quote(pages, cfg.usdPerStep)
      const j = {
        id, status: 'awaiting-payment', pages, usd: q.usd, sats: q.sats, bsvUsd: getBsvUsd(), network: cfg.network,
        address: jobAddress(cfg.masterWif, id, cfg.network), receivedSats: 0, createdAt: cfg.now(), expiresAt: cfg.now() + cfg.quoteMs
      }
      fs.writeFileSync(fileOf(j), body)
      jobs[id] = j; save()
      return sendJson(res, 200, view(j))
    }

    const m = url.match(/^\/api\/job\/([^/]+)(\/retry)?$/)
    if (m) {
      const j = ID_RE.test(m[1]) ? jobs[m[1]] : undefined
      if (!j) return sendJson(res, 404, { error: 'not-found' })
      if (req.method === 'GET' && !m[2]) return sendJson(res, 200, view(j))
      if (req.method === 'POST' && m[2]) {
        if (j.status !== 'print-failed' || !fs.existsSync(fileOf(j))) return sendJson(res, 409, { error: 'not-retryable', status: j.status })
        j.status = 'printing'; save()
        await doPrint(j) // already paid: no second payment
        return sendJson(res, 200, view(j))
      }
    }
    return send(res, 404, 'text/plain; charset=utf-8', 'Not found')
  }

  const server = http.createServer((req, res) => { handle(req, res).catch(err => { try { sendJson(res, 500, { error: err.message }) } catch { /* socket gone */ } }) })
  let timer = null
  return {
    server, pollOnce, cfg,
    jobs: () => jobs,
    startPolling() { timer = setInterval(() => pollOnce().catch(() => {}), cfg.pollMs); if (timer.unref) timer.unref() },
    stop() { if (timer) clearInterval(timer); server.close() }
  }
}

module.exports = { createShop, PAGE }

if (require.main === module) {
  if (process.argv.includes('--init')) {
    const envPath = path.join(process.cwd(), '.env')
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
    if (/^PRINTER_MASTER_WIF=/m.test(existing)) console.log('PRINTER_MASTER_WIF is already in .env — left untouched.')
    else {
      fs.appendFileSync(envPath, `${existing && !existing.endsWith('\n') ? '\n' : ''}PRINTER_MASTER_WIF=${PrivateKey.fromRandom().toWif()}\n`, { mode: 0o600 })
      console.log('PRINTER_MASTER_WIF added to .env. Back it up: whoever has it can spend every payment the shop receives.')
    }
    process.exit(0)
  }
  let shop
  try {
    shop = createShop()
  } catch (err) {
    console.error(`\n${err.message}`)
    process.exit(1)
  }
  const port = num(process.env.PRINT_PORT, 3100)
  const host = process.env.PRINT_HOST || '0.0.0.0'
  shop.server.on('error', err => {
    console.error(err.code === 'EADDRINUSE' ? `\nPort ${port} is already in use (is the shop already running?). Set PRINT_PORT in .env to use another.` : `\n${err.message}`)
    process.exit(1)
  })
  shop.server.listen(port, host, () => {
    shop.startPolling()
    console.log(`Tulostin käynnissä (portti ${port}). Avaa selaimessa:`)
    const urls = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => `  http://${n.address}:${port}`)
    console.log(urls.length ? urls.join('\n') : `  http://localhost:${port}`)
    console.log(`\nTila: ${shop.cfg.mode === 'dry' ? 'KOE (dry): tulosteet kopioidaan kansioon printed/, oikeaa tulostinta ei käytetä' : 'OIKEA tulostus'}`)
    console.log(`Verkko: ${shop.cfg.network === 'main' ? 'MAINNET: OIKEAA RAHAA' : 'testnet (ei oikeaa rahaa)'}`)
    console.log(`Hinta: $${shop.cfg.usdPerStep} per alkava 5 sivua, kurssi ${describeRate()}`)
    if (shop.cfg.network === 'main') console.log('\nVAROITUS: mainnet. Varmuuskopioi PRINTER_MASTER_WIF, se antaa pääsyn kaikkiin maksuihin.')
  })
}
