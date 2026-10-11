// printing.js
// Page counting and the actual printing.
//
// PRINT_MODE=dry (default): nothing is sent to a printer, the PDF is copied to
//   the `printed/` folder instead. Use it to test the whole flow.
// PRINT_MODE=real: Windows uses the `pdf-to-printer` package, other systems
//   the `lp` command (CUPS). PRINTER_NAME picks a printer (default printer if empty).

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

// Returns the number of pages, or throws 'not-a-pdf' / 'unreadable-pdf'.
async function countPages(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.slice(0, 5).toString('latin1') !== '%PDF-') throw new Error('not-a-pdf')
  const { PDFDocument } = require('pdf-lib')
  try {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false })
    return doc.getPageCount()
  } catch {
    throw new Error('unreadable-pdf') // damaged, or password-protected
  }
}

// `pages` = how many pages were paid for: real printing is limited to pages 1..N,
// so a PDF whose real page count differs from what we counted (a crafted file)
// still cannot print more than was charged.
// Injectable for tests: mode, printer, outDir, platform, exec (lp), ptp (pdf-to-printer).
async function printPdf(file, opts = {}) {
  const mode = opts.mode || process.env.PRINT_MODE || 'dry'
  const printer = opts.printer !== undefined ? opts.printer : process.env.PRINTER_NAME
  const platform = opts.platform || process.platform

  if (mode === 'dry') {
    const outDir = opts.outDir || path.join(__dirname, 'printed')
    fs.mkdirSync(outDir, { recursive: true })
    const out = path.join(outDir, path.basename(file))
    fs.copyFileSync(file, out)
    return { mode: 'dry', out }
  }
  if (mode !== 'real') throw new Error(`unknown PRINT_MODE: ${mode}`)

  if (platform === 'win32') {
    const ptp = opts.ptp || require('pdf-to-printer')
    await ptp.print(file, { ...(printer ? { printer } : {}), ...(opts.pages ? { pages: `1-${opts.pages}` } : {}) })
    return { mode: 'windows' }
  }
  const exec = opts.exec || execFile
  const args = [...(printer ? ['-d', printer] : []), ...(opts.pages ? ['-P', `1-${opts.pages}`] : []), file] // args array: no shell, so no injection
  await new Promise((resolve, reject) => exec('lp', args, err => (err ? reject(err) : resolve())))
  return { mode: 'lp' }
}

module.exports = { countPages, printPdf }
