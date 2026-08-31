/* หน้าเข้าสู่ระบบ + ตั้งค่าการเชื่อมต่อ */
(function () {
  'use strict';
  var $ = UI.$;

  var viewLogin = $('#viewLogin');
  var viewSetup = $('#viewSetup');
  var lastTest = null;

  /* ---------------- สลับหน้าจอ ---------------- */
  function showSetup() {
    viewLogin.classList.add('hidden');
    viewSetup.classList.remove('hidden');
    viewSetup.classList.add('fade');
    loadConfig();
  }

  function showLogin() {
    viewSetup.classList.add('hidden');
    viewLogin.classList.remove('hidden');
    viewLogin.classList.add('fade');
    refreshStatus();
    $('#username').focus();
  }

  $('#btnOpenSetup').addEventListener('click', showSetup);
  $('#btnBackLogin').addEventListener('click', showLogin);

  /* ---------------- โหลด/แสดงค่าที่จำไว้ ---------------- */
  function driverDefaults() {
    var pg = $('#drvPg').checked;
    var portEl = $('#port');
    if (!portEl.value || portEl.value === '3306' || portEl.value === '5432') {
      portEl.value = pg ? 5432 : 3306;
    }
  }
  $('#drvMysql').addEventListener('change', driverDefaults);
  $('#drvPg').addEventListener('change', driverDefaults);

  function fillConfig(c) {
    if (!c) return;
    (c.driver === 'postgres' ? $('#drvPg') : $('#drvMysql')).checked = true;
    $('#host').value = c.host || '';
    $('#port').value = c.port || (c.driver === 'postgres' ? 5432 : 3306);
    $('#database').value = c.database || '';
    $('#dbuser').value = c.username || '';
    $('#dbpass').value = c.password || '';
    $('#hospCode').value = c.hospCode || '';
    $('#token').value = c.token || '';
  }

  async function loadConfig() {
    try {
      var r = await API.call('settings.get', {});
      fillConfig(r.config);
    } catch (e) {
      UI.toast('โหลดค่าเดิมไม่สำเร็จ', e.message, 'warn');
    }
  }

  async function refreshStatus() {
    var el = $('#dbStatus');
    try {
      var r = await API.call('settings.get', {});
      var c = r.config;
      if (c.configured) {
        el.className = 'badge badge-mint';
        el.textContent = (c.driver === 'postgres' ? 'PostgreSQL' : 'MySQL') + ' · ' + c.host + ':' + c.port + '/' + c.database;
        $('#cfgWarn').classList.add('hidden');
      } else {
        el.className = 'badge badge-peach';
        el.textContent = 'ยังไม่ได้ตั้งค่า';
        $('#cfgWarn').classList.remove('hidden');
      }
    } catch (e) {
      el.className = 'badge badge-rose';
      el.textContent = 'ตรวจสอบไม่ได้';
    }
  }

  /* ---------------- สร้าง Token ---------------- */
  $('#btnGenToken').addEventListener('click', async function () {
    var hosp = $('#hospCode').value.trim();
    if (!hosp) {
      UI.toast('กรุณากรอกรหัสสถานพยาบาลก่อน', 'Token จะขึ้นต้นด้วยรหัสสถานพยาบาล', 'warn');
      $('#hospCode').focus();
      return;
    }
    try {
      var r = await API.call('settings.token', { hospCode: hosp });
      $('#token').value = r.token;
      UI.toast('สร้าง Token ใหม่แล้ว', 'อย่าลืมกดบันทึกข้อมูลเชื่อมต่อ', 'ok');
    } catch (e) {
      UI.toast('สร้าง Token ไม่สำเร็จ', e.message, 'err');
    }
  });

  $('#hospCode').addEventListener('blur', function () {
    var hosp = this.value.trim();
    var tok = $('#token').value.trim();
    if (hosp && !tok) $('#btnGenToken').click();
  });

  /* ---------------- อ่านค่าจากฟอร์ม ---------------- */
  function formValues() {
    return {
      driver: $('#drvPg').checked ? 'postgres' : 'mysql',
      host: $('#host').value.trim(),
      port: $('#port').value.trim(),
      database: $('#database').value.trim(),
      username: $('#dbuser').value.trim(),
      password: $('#dbpass').value,
      hospCode: $('#hospCode').value.trim(),
      token: $('#token').value.trim()
    };
  }

  function showResult(ok, html) {
    var box = $('#testResult');
    box.className = 'result-box show ' + (ok ? 'ok' : 'err');
    box.innerHTML = html;
  }

  /* ---------------- ทดสอบการเชื่อมต่อ ---------------- */
  $('#btnTest').addEventListener('click', async function () {
    var v = formValues();
    if (!v.host || !v.database || !v.username) {
      showResult(false, '⚠️ กรุณากรอก <b>IP Server</b>, <b>Database</b> และ <b>Username</b> ให้ครบ');
      return;
    }
    UI.busy(this, true, 'กำลังทดสอบ…');
    try {
      var r = await API.call('settings.test', v);
      var res = r.result;
      lastTest = res;
      if (res && res.ok) {
        var miss = res.missing && res.missing.length
          ? '<div style="margin-top:6px">⚠️ ไม่พบตาราง: <b>' + UI.esc(res.missing.join(', ')) + '</b></div>' : '';
        showResult(true,
          '✅ <b>เชื่อมต่อสำเร็จ</b> (' + res.elapsed + ' ms)' +
          '<div style="margin-top:6px">ฐานข้อมูล: <b>' + UI.esc(res.database || v.database) + '</b></div>' +
          '<div>เวอร์ชัน: <code>' + UI.esc(res.version) + '</code></div>' +
          '<div>ตารางที่ตรวจพบ: ' + UI.esc((res.tables || []).join(', ') || '-') + '</div>' + miss);
        UI.toast('เชื่อมต่อสำเร็จ', res.database, 'ok');
      } else {
        showResult(false, '⛔ <b>เชื่อมต่อไม่สำเร็จ</b><div style="margin-top:6px"><code>' + UI.esc((res && res.error) || r.error || 'ไม่ทราบสาเหตุ') + '</code></div>');
        UI.toast('เชื่อมต่อไม่สำเร็จ', (res && res.error) || '', 'err', 6000);
      }
    } catch (e) {
      showResult(false, '⛔ ' + UI.esc(e.message));
      UI.toast('เกิดข้อผิดพลาด', e.message, 'err');
    } finally {
      UI.busy(this, false);
    }
  });

  /* ---------------- บันทึกแล้วกลับหน้า login ---------------- */
  $('#btnSave').addEventListener('click', async function () {
    var v = formValues();
    if (!v.host || !v.database || !v.username) {
      showResult(false, '⚠️ กรุณากรอก <b>IP Server</b>, <b>Database</b> และ <b>Username</b> ให้ครบ');
      return;
    }
    if (!v.hospCode) {
      showResult(false, '⚠️ กรุณากรอก <b>รหัสสถานพยาบาล</b> เพื่อสร้าง Token');
      $('#hospCode').focus();
      return;
    }
    if (!v.token) {
      try {
        var g = await API.call('settings.token', { hospCode: v.hospCode });
        v.token = g.token;
        $('#token').value = g.token;
      } catch (e) { /* ปล่อยให้ server สร้างให้ */ }
    }
    UI.busy(this, true, 'กำลังบันทึก…');
    try {
      var r = await API.call('settings.save', v);
      API.setApiKey(r.token);          // ใช้ token ใหม่กับการเรียก API ครั้งถัดไป
      API.boot.setup = false;
      $('#token').value = r.token;
      UI.toast('บันทึกข้อมูลการเชื่อมต่อแล้ว', 'Token: ' + r.token, 'ok');
      showResult(true, '💾 บันทึกเรียบร้อย กำลังกลับไปหน้าเข้าสู่ระบบ…');
      setTimeout(function () {
        $('#testResult').className = 'result-box';
        showLogin();
      }, 700);
    } catch (e) {
      showResult(false, '⛔ ' + UI.esc(e.message));
      UI.toast('บันทึกไม่สำเร็จ', e.message, 'err');
    } finally {
      UI.busy(this, false);
    }
  });

  /* ---------------- เข้าสู่ระบบ ---------------- */
  $('#loginForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('#btnLogin');
    var errBox = $('#loginErr');
    errBox.className = 'result-box err';

    var u = $('#username').value.trim();
    var p = $('#password').value;
    if (!u || !p) {
      errBox.className = 'result-box err show';
      errBox.textContent = 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน';
      return;
    }

    UI.busy(btn, true, 'กำลังเข้าสู่ระบบ…');
    try {
      var r = await API.call('auth.login', { username: u, password: p });
      API.setSession(r.session, r.user);
      UI.toast('ยินดีต้อนรับ', r.user.name, 'ok', 1500);
      setTimeout(function () { location.href = '/app'; }, 350);
    } catch (e) {
      errBox.className = 'result-box err show';
      errBox.innerHTML = '⛔ ' + UI.esc(e.message);
      $('#password').value = '';
      $('#password').focus();
    } finally {
      UI.busy(btn, false);
    }
  });

  /* ================= BMS Session ================= */
  var BMS_COOKIE = 'bms-session-id';

  function getCookie(name) {
    var m = document.cookie.match('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : '';
  }
  function setCookie(name, val, days) {
    var exp = new Date(Date.now() + (days || 7) * 864e5).toUTCString();
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = name + '=' + encodeURIComponent(val) + '; expires=' + exp + '; path=/; SameSite=Lax' + secure;
  }
  function delCookie(name) { document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; }

  /** ดึง session id จาก URL (?bms-session-id=... หรือ #...) */
  function sidFromUrl() {
    try {
      var u = new URL(location.href);
      return (u.searchParams.get('bms-session-id') || u.searchParams.get('bms_session_id') || '').trim();
    } catch (e) { return ''; }
  }
  function cleanUrl() {
    try {
      var u = new URL(location.href);
      u.searchParams.delete('bms-session-id');
      u.searchParams.delete('bms_session_id');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    } catch (e) {}
  }

  /** เข้าสู่ระบบด้วย BMS session id */
  async function bmsLogin(sid, opts) {
    opts = opts || {};
    var r = await API.call('auth.bms', { sessionId: sid });
    API.setSession(r.session, r.user);
    setCookie(BMS_COOKIE, sid, 7);
    return r;
  }

  // ปุ่มเชื่อมด้วยมือ
  $('#btnBms').addEventListener('click', async function () {
    var sid = $('#bmsSid').value.trim();
    var errBox = $('#bmsErr');
    errBox.className = 'result-box err';
    if (!sid) {
      errBox.className = 'result-box err show';
      errBox.textContent = 'กรุณาวาง BMS Session ID';
      return;
    }
    UI.busy(this, true, 'กำลังเชื่อม…');
    try {
      var r = await bmsLogin(sid);
      UI.toast('เข้าสู่ระบบด้วย BMS สำเร็จ', r.user.name, 'ok', 1500);
      setTimeout(function () { location.href = '/app'; }, 350);
    } catch (e) {
      errBox.className = 'result-box err show';
      errBox.innerHTML = '⛔ ' + UI.esc(e.message);
      UI.busy(this, false);
    }
  });
  $('#bmsSid').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#btnBms').click(); });

  /** เข้าระบบอัตโนมัติเมื่อมี session จาก URL/cookie */
  async function tryAutoBms(sid, fromUrl) {
    $('#viewLogin').classList.add('hidden');
    $('#viewSetup').classList.add('hidden');
    var v = $('#viewBmsAuto');
    v.classList.remove('hidden');
    v.classList.add('fade');
    try {
      var r = await bmsLogin(sid);
      if (fromUrl) cleanUrl();
      $('#bmsAutoMsg').textContent = 'ยินดีต้อนรับ ' + (r.user.name || '');
      setTimeout(function () { location.href = '/app'; }, 400);
    } catch (e) {
      delCookie(BMS_COOKIE);
      $('#bmsAutoSpin').classList.add('hidden');
      $('#bmsAutoMsg').textContent = 'เข้าสู่ระบบด้วย BMS ไม่สำเร็จ';
      var err = $('#bmsAutoErr');
      err.className = 'result-box err show';
      err.innerHTML = '⛔ ' + UI.esc(e.message);
      var back = $('#btnBmsRetryLogin');
      back.classList.remove('hidden');
      back.addEventListener('click', function () {
        v.classList.add('hidden');
        if (API.boot.setup) showSetup(); else showLogin();
      });
    }
  }

  /* ---------------- เริ่มต้น ---------------- */
  var urlSid = sidFromUrl();
  var cookieSid = getCookie(BMS_COOKIE);

  if (urlSid) {
    tryAutoBms(urlSid, true);
  } else if (cookieSid) {
    tryAutoBms(cookieSid, false);
  } else if (API.boot.setup) {
    UI.toast('ยังไม่ได้ตั้งค่าระบบ', 'ตั้งค่าฐานข้อมูล หรือเข้าสู่ระบบด้วย BMS Session', 'warn', 6000);
    showSetup();
  } else {
    refreshStatus();
    $('#username').focus();
  }
})();
