/* ตัวเรียก API — เข้ารหัสคำขอ/คำตอบ และซ่อนเส้นทางจริง */
(function (global) {
  'use strict';

  var BOOT = global.__BOOT || {};
  var KEY_STORE = 'ffopd.key';
  var SESS_STORE = 'ffopd.session';
  var USER_STORE = 'ffopd.user';

  function apiKey() {
    return BOOT.k || localStorage.getItem(KEY_STORE) || '';
  }

  function setApiKey(k) {
    BOOT.k = k;
    try { localStorage.setItem(KEY_STORE, k); } catch (e) {}
  }

  function session() {
    try { return localStorage.getItem(SESS_STORE) || ''; } catch (e) { return ''; }
  }

  function setSession(tok, user) {
    try {
      if (tok) { localStorage.setItem(SESS_STORE, tok); localStorage.setItem(USER_STORE, JSON.stringify(user || {})); }
      else { localStorage.removeItem(SESS_STORE); localStorage.removeItem(USER_STORE); }
    } catch (e) {}
  }

  function currentUser() {
    try { return JSON.parse(localStorage.getItem(USER_STORE) || 'null'); } catch (e) { return null; }
  }

  /** เรียก endpoint ตามชื่อเชิงตรรกะ — ชื่อจริงถูกแปลงเป็นรหัสที่เข้ารหัสไว้ */
  async function call(name, payload) {
    var rid = (BOOT.r || {})[name];
    if (!rid) throw new Error('ไม่รู้จักปลายทาง: ' + name);

    var key = apiKey();
    var body = Object.assign({}, payload || {}, { _s: session(), _t: Date.now() });
    var sealed = global.FFCrypto.seal(body, key);

    var res = await fetch((BOOT.ep || '/q/') + rid, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-API-Token': key },
      body: sealed,
      credentials: 'same-origin'
    });

    var text = await res.text();
    var data = global.FFCrypto.open(text, key);

    if (!data) {
      // ข้อความผิดพลาดที่ไม่ได้เข้ารหัส (เช่น token ผิด)
      try {
        var plain = JSON.parse(text);
        throw new Error(plain.error || 'เกิดข้อผิดพลาด (' + res.status + ')');
      } catch (e) {
        if (e instanceof SyntaxError) throw new Error('ตอบกลับไม่ถูกต้อง (' + res.status + ')');
        throw e;
      }
    }
    if (!data.ok) {
      var err = new Error(data.error || 'เกิดข้อผิดพลาด');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  global.API = {
    call: call,
    boot: BOOT,
    apiKey: apiKey,
    setApiKey: setApiKey,
    session: session,
    setSession: setSession,
    currentUser: currentUser
  };
})(window);
