





















const axios = require('axios');
const pool = require('../db/pool');

let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch {
  
  
  
}


function parseDirectoryText(text) {
  
  
  const cleaned = text
    .replace(/C2:\s*CBK\s*-\s*Official/gi, '')
    .replace(/CENTRAL BANK OF KENYA/gi, '')
    .replace(/DIRECTORY OF DIGITAL CREDIT PROVIDERS/gi, '')
    .replace(/UPDATED ON [A-Z]+ \d{1,2},? \d{4}/gi, '')
    .replace(/^\s*\d+\s*$/gm, ''); 

  
  
  const parts = cleaned.split(/\n\s*(\d{1,3})\.\s+/);
  const entries = [];
  
  
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
