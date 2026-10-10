// Robust .docx -> word/document.xml extractor (Node built-ins only)
const fs = require('fs');
const zlib = require('zlib');

const data = fs.readFileSync(process.argv[2]);
const target = process.argv[3];

let idx = 0;
const n = data.length;
while (idx < n - 30) {
  // Only treat as a local header if the 4 signature bytes are at the very start
  if (data[idx] === 0x50 && data[idx + 1] === 0x4B && data[idx + 2] === 0x03 && data[idx + 3] === 0x04) {
    const flen = data.readUInt16BE(idx + 26);
    const elen = data.readUInt16BE(idx + 28);
    const csize = data.readUInt32LE(idx + 18);
    const usize = data.readUInt32LE(idx + 22);
    const fnameStart = idx + 46;
    if (fnameStart + flen <= n) {
      const fname = data.slice(fnameStart, fnameStart + flen).toString('utf8');
      if (fname === 'word/document.xml') {
        const body = zlib.inflateRawSync(data.subarray(idx + 30 + flen + elen, idx + 30 + flen + elen + csize));
        fs.writeFileSync(target, body);
        console.log('wrote', target, body.length, 'bytes (logical', usize, ')');
        process.exit(0);
      }
    }
  }
  // Advance to the start of the next local file header.
  const flen = data.readUInt16BE(idx + 26);
  const elen = data.readUInt16BE(idx + 28);
  const csize = data.readUInt32LE(idx + 18);
  const next = idx + 30 + flen + elen + csize;
  if (next <= idx) { console.error('progress blocked'); process.exit(1); }
  idx = next;
}
console.error('file not found');
process.exit(1);
