'use strict';
/**
 * ชั้นความปลอดภัย: เข้ารหัสเส้นทาง API (route obfuscation) + เข้ารหัสข้อมูลรับ/ส่ง
 * ใช้ SHA256-CTR stream cipher + HMAC-SHA256 เพื่อให้ฝั่ง browser ทำงานได้
 * โดยไม่ต้องพึ่ง window.crypto.subtle (ซึ่งใช้ไม่ได้บน http:// ผ่าน LAN)
 */
const crypto = require('crypto');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

/** สร้าง keystream ยาว n bytes จาก key */
function keystream(key, nonce, n) {
  const out = Buffer.alloc(n);
  let off = 0, ctr = 0;
  while (off < n) {
    const block = sha256(Buffer.concat([key, nonce, Buffer.from(String(ctr))]));
    block.copy(out, off, 0, Math.min(32, n - off));
    off += 32; ctr++;
  }
  return out;
}

/** key 32 bytes จาก token */
function deriveKey(token, salt) {
  return sha256(Buffer.from('FFOPD|' + token + '|' + (salt || ''), 'utf8'));
}

/** เข้ารหัส object -> string  "nonceHex.cipherB64.macHex" */
function seal(obj, token) {
  const key = deriveKey(token);
  const nonce = crypto.randomBytes(12);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const ks = keystream(key, nonce, plain.length);
  const ct = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i++) ct[i] = plain[i] ^ ks[i];
  const mac = crypto.createHmac('sha256', key).update(Buffer.concat([nonce, ct])).digest();
  return nonce.toString('hex') + '.' + ct.toString('base64') + '.' + mac.toString('hex').slice(0, 32);
}

/** ถอดรหัส string -> object (คืน null ถ้าไม่ถูกต้อง) */
function open(payload, token) {
  try {
    const [nHex, ctB64, macHex] = String(payload).split('.');
    if (!nHex || !ctB64 || !macHex) return null;
    const key = deriveKey(token);
    const nonce = Buffer.from(nHex, 'hex');
    const ct = Buffer.from(ctB64, 'base64');
    const mac = crypto.createHmac('sha256', key).update(Buffer.concat([nonce, ct])).digest().toString('hex').slice(0, 32);
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(macHex))) return null;
    const ks = keystream(key, nonce, ct.length);
    const plain = Buffer.alloc(ct.length);
    for (let i = 0; i < ct.length; i++) plain[i] = ct[i] ^ ks[i];
    return JSON.parse(plain.toString('utf8'));
  } catch (e) { return null; }
}

/** ชื่อ endpoint -> รหัสเส้นทางที่ถูกเข้ารหัส (คงที่ต่อ 1 การติดตั้ง) */
function routeId(secret, name) {
  return crypto.createHmac('sha256', secret).update('route:' + name).digest('hex').slice(0, 24);
}

/** สร้าง token: รหัสสถานพยาบาล + 10 หลักสุ่ม */
function generateToken(hospCode) {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rnd = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) rnd += ALPHABET[bytes[i] % ALPHABET.length];
  return String(hospCode || '').trim() + rnd;
}

/** session token แบบมีลายเซ็น (ไม่ต้องพึ่ง lib ภายนอก) */
function signSession(payload, secret, ttlSeconds) {
  const body = Object.assign({}, payload, { exp: Date.now() + (ttlSeconds || 28800) * 1000 });
  const b = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(b).digest('base64url');
  return b + '.' + sig;
}

function verifySession(tok, secret) {
  try {
    const [b, sig] = String(tok).split('.');
    if (!b || !sig) return null;
    const expect = crypto.createHmac('sha256', secret).update(b).digest('base64url');
    if (expect.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
    const body = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    if (!body.exp || body.exp < Date.now()) return null;
    return body;
  } catch (e) { return null; }
}

const md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

module.exports = { seal, open, routeId, generateToken, signSession, verifySession, md5, sha256, deriveKey };
