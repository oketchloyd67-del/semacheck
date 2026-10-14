'use strict';
// backend/services/ssrfGuard.js
// Stops webhook URLs from pointing at private, loopback or cloud-metadata
// addresses (SSRF). Call it when a URL is saved AND again right before every
// delivery — DNS can change in between (DNS rebinding).

const dns = require('dns').promises;
const net = require('net');

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||            // link-local, includes cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||  // carrier-grade NAT
    a >= 224;                              // multicast and reserved
}

function isPrivateIPv6(ip) {
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') ||
    x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.') || x.startsWith('::ffff:169.254.');
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

// Returns { ok: true } or { ok: false, reason }
async function checkWebhookUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return { ok: false, reason: 'invalid_url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https_required' };
  if (u.username || u.password) return { ok: false, reason: 'credentials_in_url' };
  if (u.port && u.port !== '443') return { ok: false, reason: 'port_not_allowed' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, reason: 'host_not_allowed' };
  if (net.isIP(host)) return isPrivateIp(host) ? { ok: false, reason: 'private_address' } : { ok: true };
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { return { ok: false, reason: 'dns_failed' }; }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) return { ok: false, reason: 'private_address' };
  return { ok: true };
}

module.exports = { checkWebhookUrl, isPrivateIp };
