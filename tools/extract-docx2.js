// Precisely extract word/document.xml from a .docx
const fs = require('fs');
const zlib = require('zlib');

const data = fs.readFileSync(process.argv[2]);
let idx = 0;
while (idx + 30 <= data.length) {
  if (data[idx] === 0x50 && data[idx + 1] === 0x4B && data[idx + 2] === 0x03 && data[idx + 3] === 0x04) {
    const flen = data.readUInt16BE(idx + 26);
    const elen = data.readUInt16BE(idx + 28);
    const csize = data.readUInt32LE(idx + 18);
    const usize = data.readUInt32LE(idx + 22);
    const fname = data.slice(idx + 46, idx + 46 + flen).toString('utf8');
    if (fname === 'word/document.xml') {
      const body = zlib.inflateRawSync(data.subarray(idx + 30 + flen + elen, idx + 30 + flen + elen + csize));
      fs.writeFileSync(process.argv[3], body);
      console.log('wrote', process.argv[3], body.length, 'bytes (logical', usize, ')');
      process.exit(0);
    }
  }
  // Advance to next local header: move index to the end of this record's data
  const flen = data.readUInt16BE(idx + 26);
  const elen = data.readUInt16BE(idx + 28);
  const csize = data.readUInt32LE(idx + 18);
  const usize = data.readUInt32LE(idx + 22);
  const extraCommentEnd = idx + 30 + flen + elen + csize;
  if (extraCommentEnd > data.length) { console.error('bad record len'); process.exit(1); }
  idx = extraCommentEnd;
}
console.error('word/document.xml not found');
process.exit(1);
