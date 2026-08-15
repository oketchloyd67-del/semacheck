// middleware/upload.js
// Handles the ID-document photo uploaded during signup. Files are kept
// OUTSIDE any publicly served directory — they're only ever readable via
// the admin-only route in routes/admin.js (requireAdmin), never by URL.
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'id-documents');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_BYTES = 8 * 1024 * 1024; // 8MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const randomName = crypto.randomBytes(20).toString('hex'); // never trust/keep the user-supplied filename
    cb(null, `${randomName}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME.includes(file.mimetype)) {
    return cb(new Error('ID document must be a JPG, PNG, WEBP, or PDF file.'));
  }
  cb(null, true);
};

const multerUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_BYTES, files: 1 },
}).single('idDocument');

// Wraps multer so upload errors (wrong type, too large, missing field)
// come back as a normal JSON 400 instead of falling through to the
// generic error handler in server.js.
function uploadIdDocument(req, res, next) {
  multerUpload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'ID document must be under 8MB.' });
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

module.exports = { uploadIdDocument, UPLOAD_DIR };
