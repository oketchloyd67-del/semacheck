const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'id-documents');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_BYTES = 8 * 1024 * 1024;

const ID_IMAGE_MIME = ['image/jpeg', 'image/png'];
const DOC_PDF_MIME = ['application/pdf'];
const ALL_ALLOWED_MIME = [...ID_IMAGE_MIME, ...DOC_PDF_MIME];

const MAGIC_SIGNATURES = {
  jpeg: Buffer.from([0xFF, 0xD8, 0xFF]),
  png: Buffer.from([0x89, 0x50, 0x4E, 0x47]),
  pdf: Buffer.from([0x25, 0x50, 0x44, 0x46]),
};

function detectFileType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  for (const [type, sig] of Object.entries(MAGIC_SIGNATURES)) {
    if (sig.equals(buffer.subarray(0, sig.length))) return type;
  }
  return null;
}

function validateMagicBytes(filePath, declaredMime) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(8);
    fs.readSync(fd, header, 0, 8, 0);
    fs.closeSync(fd);

    const detected = detectFileType(header);

    if (declaredMime === 'image/jpeg' || declaredMime === 'image/png') {
      if (detected !== 'jpeg' && detected !== 'png') {
        return 'File content does not match a valid image. Only JPEG and PNG are accepted for ID uploads.';
      }
    } else if (declaredMime === 'application/pdf') {
      if (detected !== 'pdf') {
        return 'File content does not match a valid PDF. Only PDF documents are accepted.';
      }
    } else {
      return 'Unsupported file type.';
    }

    if (declaredMime === 'image/jpeg' && detected !== 'jpeg') {
      return 'File extension says JPEG but the content is not a valid JPEG image.';
    }
    if (declaredMime === 'image/png' && detected !== 'png') {
      return 'File extension says PNG but the content is not a valid PNG image.';
    }
    if (declaredMime === 'application/pdf' && detected !== 'pdf') {
      return 'File extension says PDF but the content is not a valid PDF document.';
    }

    return null;
  } catch {
    return 'Could not read file for verification.';
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const randomName = crypto.randomBytes(20).toString('hex');
    cb(null, `${randomName}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (!ALL_ALLOWED_MIME.includes(file.mimetype)) {
    return cb(new Error('ID document must be a JPG, PNG image, or PDF file.'));
  }
  cb(null, true);
};

const multerUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_BYTES, files: 1 },
}).single('idDocument');

function uploadIdDocument(req, res, next) {
  multerUpload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'ID document must be under 8MB.' });
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) return res.status(400).json({ error: err.message });

    if (!req.file) return next();

    const validationError = validateMagicBytes(req.file.path, req.file.mimetype);
    if (validationError) {
      fs.unlink(req.file.path, () => {});
      req.file = null;
      return res.status(400).json({ error: validationError });
    }

    next();
  });
}

module.exports = { uploadIdDocument, UPLOAD_DIR, validateMagicBytes, detectFileType };
