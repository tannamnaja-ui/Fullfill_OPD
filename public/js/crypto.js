/* ชั้นเข้ารหัสฝั่ง browser — SHA-256 + stream cipher (ทำงานได้แม้ไม่ใช่ secure context) */
(function (global) {
  'use strict';

  /* ---------- SHA-256 ---------- */
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256(bytes) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length;
    var withOne = len + 1;
    var padLen = ((withOne + 8 + 63) & ~63);
    var msg = new Uint8Array(padLen);
    msg.set(bytes);
    msg[len] = 0x80;
    var bitLenHi = Math.floor(len / 536870912);
    var bitLenLo = (len * 8) >>> 0;
    msg[padLen - 8] = (bitLenHi >>> 24) & 0xff;
    msg[padLen - 7] = (bitLenHi >>> 16) & 0xff;
    msg[padLen - 6] = (bitLenHi >>> 8) & 0xff;
    msg[padLen - 5] = bitLenHi & 0xff;
    msg[padLen - 4] = (bitLenLo >>> 24) & 0xff;
    msg[padLen - 3] = (bitLenLo >>> 16) & 0xff;
    msg[padLen - 2] = (bitLenLo >>> 8) & 0xff;
    msg[padLen - 1] = bitLenLo & 0xff;

    var w = new Int32Array(64);
    for (var off = 0; off < padLen; off += 64) {
      var i;
      for (i = 0; i < 16; i++) {
        w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3];
      }
      for (i = 16; i < 64; i++) {
        var g0 = w[i - 15], g1 = w[i - 2];
        var s0 = ((g0 >>> 7) | (g0 << 25)) ^ ((g0 >>> 18) | (g0 << 14)) ^ (g0 >>> 3);
        var s1 = ((g1 >>> 17) | (g1 << 15)) ^ ((g1 >>> 19) | (g1 << 13)) ^ (g1 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var out = new Uint8Array(32);
    for (var j = 0; j < 8; j++) {
      out[j * 4] = (h[j] >>> 24) & 0xff;
      out[j * 4 + 1] = (h[j] >>> 16) & 0xff;
      out[j * 4 + 2] = (h[j] >>> 8) & 0xff;
      out[j * 4 + 3] = h[j] & 0xff;
    }
    return out;
  }

  function hmac(key, data) {
    var k = key.length > 64 ? sha256(key) : key;
    var ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (var i = 0; i < 64; i++) {
      var kb = i < k.length ? k[i] : 0;
      ipad[i] = kb ^ 0x36;
      opad[i] = kb ^ 0x5c;
    }
    var inner = sha256(concat(ipad, data));
    return sha256(concat(opad, inner));
  }

  /* ---------- helpers ---------- */
  function concat() {
    var total = 0, i;
    for (i = 0; i < arguments.length; i++) total += arguments[i].length;
    var out = new Uint8Array(total), off = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], off); off += arguments[i].length; }
    return out;
  }

  function utf8(str) {
    if (global.TextEncoder) return new TextEncoder().encode(str);
    var s = unescape(encodeURIComponent(str)), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function fromUtf8(bytes) {
    if (global.TextDecoder) return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  function fromHex(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function toB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function fromB64(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    var out = new Uint8Array(n);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(out);
    else for (var i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  }

  /* ---------- stream cipher (ตรงกับฝั่ง server) ---------- */
  function deriveKey(token) {
    return sha256(utf8('FFOPD|' + token + '|'));
  }

  function keystream(key, nonce, n) {
    var out = new Uint8Array(n), off = 0, ctr = 0;
    while (off < n) {
      var block = sha256(concat(key, nonce, utf8(String(ctr))));
      out.set(block.subarray(0, Math.min(32, n - off)), off);
      off += 32; ctr++;
    }
    return out;
  }

  function seal(obj, token) {
    var key = deriveKey(token);
    var nonce = randomBytes(12);
    var plain = utf8(JSON.stringify(obj));
    var ks = keystream(key, nonce, plain.length);
    var ct = new Uint8Array(plain.length);
    for (var i = 0; i < plain.length; i++) ct[i] = plain[i] ^ ks[i];
    var mac = toHex(hmac(key, concat(nonce, ct))).slice(0, 32);
    return toHex(nonce) + '.' + toB64(ct) + '.' + mac;
  }

  function open(payload, token) {
    try {
      var parts = String(payload).split('.');
      if (parts.length !== 3) return null;
      var key = deriveKey(token);
      var nonce = fromHex(parts[0]);
      var ct = fromB64(parts[1]);
      var mac = toHex(hmac(key, concat(nonce, ct))).slice(0, 32);
      if (mac !== parts[2]) return null;
      var ks = keystream(key, nonce, ct.length);
      var plain = new Uint8Array(ct.length);
      for (var i = 0; i < ct.length; i++) plain[i] = ct[i] ^ ks[i];
      return JSON.parse(fromUtf8(plain));
    } catch (e) { return null; }
  }

  global.FFCrypto = { sha256: sha256, hmac: hmac, seal: seal, open: open, toHex: toHex, utf8: utf8 };
})(window);
