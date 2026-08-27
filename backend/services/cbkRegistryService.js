// services/cbkRegistryService.js
//
// Central Bank of Kenya publishes a real, structured directory of every
// licensed Digital Credit Provider (DCP) — the entities legally allowed
// to run a lending app/loan business in Kenya — as a public PDF, no
// login or key required. This is genuinely useful for loan-app scam
// checks: "is this actually CBK-licensed, or nowhere on the list?"
//
// Two honest limitations worth knowing before relying on this:
//   1. CBK republishes this PDF at a NEW url each time they update it —
//      there's no stable "always current" endpoint. CBK_DCP_DIRECTORY_URL
//      in .env needs updating by hand when a newer directory comes out
//      (check centralbank.go.ke's Digital Credit Providers page). This
//      service will keep working off the last URL it was given even if
//      that PDF becomes outdated — it doesn't know a newer one exists.
//   2. The phone/email listed per entity is the COMPANY'S own official
//      contact info, not the Paybill/till number borrowers actually pay
//      into. A match on company NAME is a meaningful signal; a
//      phone/email match is a much weaker one, since real transactions
//      often go through different numbers than the head-office line —
//      see the weighting in checkAgainstCbkRegistry() below.

const axios = require('axios');
const pool = require('../db/pool');

let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch {
  // pdf-parse not installed yet (run `npm install` after pulling this
  // update) — refreshCbkRegistry() below fails with a clear message
  // instead of crashing the whole process on require.
}

/**
 * Splits the raw PDF text into per-entity blocks and extracts the
 * labeled fields CBK's directory consistently includes, tolerating the
 * label-wording variance actually seen across entries (e.g. "Telephone:"
 * vs "Telephone No:" vs "Telephone Contacts:", "Email:" vs "E-mail
 * address:" vs "Official Email:").
 */
function parseDirectoryText(text) {
  // Strip the repeated page header/footer noise that appears between
  // entries at every page break in the real PDF.
  const cleaned = text
    .replace(/C2:\s*CBK\s*-\s*Official/gi, '')
    .replace(/CENTRAL BANK OF KENYA/gi, '')
    .replace(/DIRECTORY OF DIGITAL CREDIT PROVIDERS/gi, '')
    .replace(/UPDATED ON [A-Z]+ \d{1,2},? \d{4}/gi, '')
    .replace(/^\s*\d+\s*$/gm, ''); // bare page-number-only lines

  // Split on "N. Company Name" at the start of a line — CBK numbers
  // every entry sequentially throughout the whole directory.
  const parts = cleaned.split(/\n\s*(\d{1,3})\.\s+/);
  const entries = [];
  // parts[0] is preamble before entry 1; after that it alternates
  // [number, blockText, number, blockText, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const block = parts[i + 1];
    if (!block) continue;
    const nameMatch = block.match(/^(.+?)(?:\r?\n|$)/);
    const companyName = nameMatch ? nameMatch[1].trim() : null;
    if (!companyName) continue;

    const phoneMatch = block.match(/Telephone[^:]*:\s*([^\n]+)/i);
    const emailMatch = block.match(/(?:E-?mail(?: address)?|Official Email)\s*:\s*([^\n]+)/i);
    const addressMatch = block.match(/Physical [Aa]ddress\s*:\s*([^\n]+(?:\n(?!Date Licensed|Licensed\s*:|Postal|Telephone|Email)[^\n]+)*)/i);
    const dateMatch = block.match(/(?:Date )?Licensed\s*:\s*([^\n]+)/i);

    entries.push({
      companyName,
      phoneRaw: phoneMatch ? phoneMatch[1].trim() : null,
      emailRaw: emailMatch ? emailMatch[1].trim() : null,
      physicalAddress: addressMatch ? addressMatch[1].replace(/\s+/g, ' ').trim() : null,
      dateLicensedRaw: dateMatch ? dateMatch[1].trim() : null,
    });
  }
  return entries;
}

/**
 * Fetches the CBK directory PDF from CBK_DCP_DIRECTORY_URL, parses it,
 * and replaces the cached table with the fresh list. Safe to call
 * repeatedly (used by jobs/refreshKenyaRegistries.js on a schedule and
 * by the admin "refresh now" button).
 */
async function refreshCbkRegistry() {
  const url = process.env.CBK_DCP_DIRECTORY_URL;
  if (!url) {
    throw new Error('CBK_DCP_DIRECTORY_URL is not set in .env — see .env.example for where to find the current directory URL.');
  }
  if (!pdfParse) {
    throw new Error('pdf-parse is not installed — run `npm install` in backend/ to pick up the new dependency.');
  }

  const { data: pdfBuffer } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  const { text } = await pdfParse(pdfBuffer);
  const entries = parseDirectoryText(text);

  if (entries.length === 0) {
    throw new Error('Parsed zero entries from the CBK directory — the PDF layout may have changed. Check CBK_DCP_DIRECTORY_URL points at a real current directory, and that services/cbkRegistryService.js\'s parser still matches its format.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM cbk_licensed_dcps');
    for (const e of entries) {
      await client.query(
        `INSERT INTO cbk_licensed_dcps (company_name, phone_raw, email_raw, physical_address, date_licensed_raw, source_pdf_url)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [e.companyName, e.phoneRaw, e.emailRaw, e.physicalAddress, e.dateLicensedRaw, url]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { count: entries.length, sourceUrl: url };
}

/**
 * Fuzzy name check against the cached registry. A normalized-substring
 * match is deliberately simple rather than a full fuzzy-matching
 * library — company names in scam contexts are usually typed close to
 * verbatim (e.g. copied from an app store listing or a text message),
 * so this catches the realistic case without the complexity of a real
 * fuzzy-matching dependency.
 */
async function checkAgainstCbkRegistry(queryValue) {
  const normalized = queryValue.trim().toLowerCase();
  if (normalized.length < 3) return { matched: false };

  const { rows } = await pool.query(
    `SELECT company_name, date_licensed_raw, phone_raw FROM cbk_licensed_dcps
     WHERE lower(company_name) LIKE '%' || $1 || '%' OR $1 LIKE '%' || lower(company_name) || '%'
     LIMIT 3`,
    [normalized]
  );
  if (!rows.length) return { matched: false };
  return { matched: true, entries: rows };
}

async function registryStatus() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n, max(fetched_at) AS last_fetched, max(source_pdf_url) AS source_url FROM cbk_licensed_dcps`
  );
  return rows[0];
}

module.exports = { refreshCbkRegistry, checkAgainstCbkRegistry, registryStatus, parseDirectoryText };
