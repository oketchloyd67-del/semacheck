// Extract word/document.xml from a .docx (OOXML ZIP) using Node built-ins
const fs = require('fs');
const zlib = require('zlib');

const path = process.argv[2];
const out = process.argv[3];

const data = fs.readFileSync(path);

// 1) Locate local file header whose filename is word/document.xml
let localOff = -1;
let flen = 0;
let elen = 0;
let csize = 0;
for (let i = 0; i + 30 <= data.length; i++) {
  if (data[i] !== 0x50 || data[i + 1] !== 0x4B || data[i + 2] !== 0x03 || data[i + 3] !== 0x04) continue;
  flen = data.readUInt16BE(i + 26);
  elen = data.readUInt16BE(i + 28);
  csize = data.readUInt32LE(i + 18);
  const fname = data.slice(i + 46, i + 46 + flen).toString('utf8');
  if (fname === 'word/document.xml') {
    localOff = i;
    break;
  }
}
if (localOff < 0) {
  console.error('word/document.xml not found');
  process.exit(1);
}

const body = zlib.inflateRawSync(data.subarray(localOff + 30 + flen + elen, localOff + 30 + flen + elen + csize));
fs.writeFileSync(out, body);
console.log('wrote', out, body.length, 'bytes');
