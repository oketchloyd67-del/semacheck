// Parse the Central Directory properly and extract word/document.xml.
const fs = require('fs');
const zlib = require('zlib');

const data = fs.readFileSync(process.argv[2]);

// Locate the End of Central Directory (EOCD).
let eocd = -1;
for (let i = data.length - 22; i >= 0; i--) {
  if (data[i] === 0x50 && data[i + 1] === 0x4B && data[i + 2] === 0x01 && data[i + 3] === 0x02 &&
      data[i + 8] === 0x00 && data[i + 9] === 0x00 && data[i + 10] === 0x00 && data[i + 11] === 0x00) {
    // sanity: this is the end record
    eocd = i;
    break;
  }
}
if (eocd < 0) { console.error('EOCD not found'); process.exit(1); }

const cdOffset = data.readUInt32LE(eocd + 16);
const entries = data.readUInt16LE(eocd + 10);

// Walk the central directory entries.
let ptr = cdOffset;
const files = [];
for (let e = 0; e < entries; e++) {
  if (ptr + 46 > data.length) break;
  const sig = data.readUInt32LE(ptr);
  if (sig !== 0x02014B50) { ptr++; continue; }
  const flen = data.readUInt16LE(ptr + 28);
  const elen = data.readUInt16LE(ptr + 30);
  const clen = data.readUInt16LE(ptr + 32);
  const localOffset = data.readUInt32LE(ptr + 42);
  const fname = data.slice(ptr + 46, ptr + 46 + flen).toString('utf8');
  files.push({ name: fname, localOffset, csize: data.readUInt32LE(ptr + 20), usize: data.readUInt32LE(ptr + 24) });
  ptr += 46 + flen + elen + clen;
}

const doc = files.find(f => f.name === 'word/document.xml');
if (!doc) { console.error('document.xml not in CD'); process.exit(1); }
console.log('document.xml localOffset:', doc.localOffset, 'csize:', doc.csize, 'usize:', doc.usize);

const body = zlib.inflateRawSync(data.subarray(doc.localOffset + 30, doc.localOffset + 30 + doc.csize));
fs.writeFileSync(process.argv[3], body);
console.log('wrote', body.length, 'bytes');
