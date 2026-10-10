// Scan a .docx for the word/document.xml local file header by walking all
// local headers with full bounds validation, then inflate and print readable text.
const fs = require('fs');
const zlib = require('zlib');

const data = fs.readFileSync(process.argv[2]);
const n = data.length;

// Collect candidate offsets where the local header signature appears,
// but only keep those that look like a real local header (valid-ish fields,
// filename ~word/document.xml or similar).
const candidates = [];
for (let i = 0; i + 30 <= n; i++) {
  if (data[i] !== 0x50 || data[i + 1] !== 0x4B || data[i + 2] !== 0x03 || data[i + 3] !== 0x04) continue;
  const flen = data.readUInt16BE(i + 26);
  const elen = data.readUInt16BE(i + 28);
  const csize = data.readUInt32LE(i + 18);
  const usize = data.readUInt32LE(i + 22);
  const fname = data.slice(i + 46, i + 46 + flen).toString('utf8');
  // a real local header: filename is short, nonzero, and within the rest of the file
  if (flen > 0 && flen <= 120 && elen === 0 && csize > 0 && flen + 46 <= n) {
    candidates.push({ i, flen, elen, csize, usize, fname });
  }
}
console.log('candidate local headers:', candidates.length);
candidates.forEach(c => console.log('  off', c.i, 'fl', c.flen, 'el', c.elen, 'csize', c.csize, 'usize', c.usize, 'fname', JSON.stringify(c.fname)));

// Also print len and first bytes of what sits at each candidate to disambiguate.
candidates.forEach(c => {
  const after = c.i + 30 + c.flen + c.elen;
  const slice = data.subarray(after, after + 24);
  console.log('  check', c.i, '-> after', after, 'bytes', JSON.stringify(slice.slice(0,12)));
});
