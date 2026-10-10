function allowedOrigin(key, origin) {
  if (!origin) return false;
  if (origin === 'http://localhost:5500' || origin === 'https://localhost' || origin === 'http://localhost') return true;
  if (key.allowed_domains && key.allowed_domains.length) {
    return key.allowed_domains.some((d) => {
      if (d === '*') return true;
      try {
        const host = new URL(origin).hostname;
        return host === d || host.endsWith('.' + d);
      } catch {
        return false;
      }
    });
  }
  return false;
}

function widgetOrigin(req, res, next) {
  const key = req.apiKey;
  if (!key || key.key_type !== 'publishable') {
    return res.status(403).json({ error: 'forbidden_origin' });
  }

  const origin = req.headers.origin || req.headers.referer || '';
  if (typeof origin === 'string' && origin) {
    if (!allowedOrigin(key, origin)) {
      return res.status(403).json({ error: 'forbidden_origin' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Vary', 'Origin');
  next();
}

module.exports = { widgetOrigin, allowedOrigin };
