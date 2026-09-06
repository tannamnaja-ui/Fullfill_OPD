/* หน้าหลัก: แดชบอร์ด + ตรวจสอบและเพิ่มข้อมูล */
(function () {
  'use strict';
  var $ = UI.$, $$ = UI.$$, esc = UI.esc;

  var state = {
    page: 'dashboard',
    mode: 'db',
    from: UI.todayStr(),
    to: UI.todayStr(),
    dep: '',
    status: 'incomplete',
    q: '',
    rules: [],
    lookups: null,
    visits: [],
    deps: []
  };

  /** ถ้า session หมดอายุ (โดยเฉพาะ BMS) ให้กลับไปหน้า login */
  function guardExpiry(e) {
    if (e && (e.status === 401 || e.status === 440)) {
      UI.toast('เซสชันหมดอายุ', 'กรุณาเข้าสู่ระบบใหม่', 'warn');
      API.setSession(null);
      setTimeout(function () { location.href = '/'; }, 1200);
      return true;
    }
    return false;
  }

  // ป้ายกำกับฟิลด์ที่ตรวจ (ใช้กับส่วน "ข้อมูลที่ลงเพิ่ม" บนแดชบอร์ด)
  var CHECK_LABEL = {
    hospmain: 'รพ.หลัก', pdx: 'Pdx (ICD10)', cc: 'อาการสำคัญ (CC)', doctor: 'แพทย์',
    bps: 'SBP', bpd: 'DBP', temperature: 'อุณหภูมิ', bw: 'น้ำหนัก', bmi: 'BMI'
  };

  /* ================= เริ่มต้น ================= */
  async function boot() {
    if (!API.session()) { location.href = '/'; return; }

    var u = API.currentUser() || {};
    $('#userName').textContent = u.name || u.username || 'ผู้ใช้งาน';
    $('#userRole').textContent = u.position || ('รหัส ' + (u.officerId || '-'));
    $('#userAv').textContent = (u.name || u.username || '?').trim().charAt(0).toUpperCase();

    $('#dFrom').value = state.from;
    $('#dTo').value = state.to;

    var me;
    try {
      me = await API.call('auth.me', {});
    } catch (e) {
      UI.toast('เซสชันหมดอายุ', 'กรุณาเข้าสู่ระบบใหม่', 'warn');
      API.setSession(null);
      setTimeout(function () { location.href = '/'; }, 900);
      return;
    }

    state.mode = (me && me.mode) || 'db';
    if (state.mode === 'bms') {
      $('#tokenBadge').textContent = '🔗 BMS Session';
      $('#tokenBadge').className = 'badge badge-mint';
      $('#hospLabel').textContent = (u.location || 'เข้าระบบผ่าน BMS Session');
      $('#userRole').textContent = u.position || 'BMS Session';
    } else {
      var tok = API.apiKey();
      $('#tokenBadge').textContent = '🔐 ' + (tok ? tok.slice(0, 5) + '••••••••••' : '—');
      $('#hospLabel').textContent = API.boot.hosp ? 'รหัสสถานพยาบาล ' + API.boot.hosp : 'HOSxP Database';
    }

    bindEvents();
    await loadDepartments();
    await refresh();
    loadLookups();
  }

  function bindEvents() {
    $$('.nav-item').forEach(function (b) {
      b.addEventListener('click', function () { go(b.dataset.page); });
    });
    $('#btnApply').addEventListener('click', refresh);
    $('#btnReload').addEventListener('click', function () { loadDepartments(); refresh(); });
    $('#btnLogout').addEventListener('click', logout);
    $('#btnBurger').addEventListener('click', function () { $('#side').classList.toggle('open'); });

    $('#dFrom').addEventListener('change', function () {
      state.from = this.value || UI.todayStr();
      if ($('#dTo').value < state.from) { $('#dTo').value = state.from; state.to = state.from; }
      loadDepartments();
    });
    $('#dTo').addEventListener('change', function () {
      state.to = this.value || state.from;
      loadDepartments();
    });
    bindDepCombo();
    $('#stSel').addEventListener('change', function () { state.status = this.value; refresh(); });

    var t = null;
    $('#qInput').addEventListener('input', function () {
      var v = this.value;
      clearTimeout(t);
      t = setTimeout(function () { state.q = v; if (state.page === 'check') refresh(); }, 350);
    });
    $('#qInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') refresh(); });
  }

  async function logout() {
    try { await API.call('auth.logout', {}); } catch (e) {}
    API.setSession(null);
    // ล้าง cookie ของ BMS session ด้วย เพื่อไม่ให้เข้าอัตโนมัติซ้ำ
    document.cookie = 'bms-session-id=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    location.href = '/';
  }

  function go(page) {
    state.page = page;
    $$('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.page === page); });
    var dash = page === 'dashboard';
    $('#pageDashboard').classList.toggle('hidden', !dash);
    $('#pageCheck').classList.toggle('hidden', dash);
    $('#fgStatus').classList.toggle('hidden', dash);
    $('#fgSearch').classList.toggle('hidden', dash);
    $('#pageTitle').textContent = dash ? 'แดชบอร์ดข้อมูลที่ลงเพิ่ม' : 'ตรวจสอบและเพิ่มข้อมูล';
    $('#pageSub').textContent = dash
      ? 'ภาพรวมความสมบูรณ์ของข้อมูลผู้รับบริการ และรายการที่ลงเพิ่มผ่านระบบ'
      : 'ตรวจสอบรายการที่ข้อมูลไม่ครบ และบันทึกข้อมูลเพิ่มเติมเข้าฐานข้อมูล';
    $('#side').classList.remove('open');
    refresh();
  }

  function params() {
    return { from: state.from, to: state.to, dep: state.dep };
  }

  /* ================= จุดบริการ (combobox ค้นหาได้) ================= */
  var ALL_DEP = { dep_code: '', dep_name: '— ทุกจุดบริการ —', visit_count: null };

  async function loadDepartments() {
    var keep = state.dep;
    try {
      var r = await API.call('data.departments', params());
      state.deps = [ALL_DEP].concat(r.departments);
    } catch (e) {
      state.deps = [ALL_DEP];
      UI.toast('โหลดจุดบริการไม่สำเร็จ', e.message, 'err');
    }
    // คงค่าที่เลือกไว้ถ้ายังมีในรายการ ไม่งั้นรีเซ็ตเป็นทุกจุดบริการ
    var found = state.deps.filter(function (d) { return String(d.dep_code) === String(keep); })[0];
    if (!found) { state.dep = ''; found = ALL_DEP; }
    $('#depSel').value = state.dep;
    $('#depSearch').value = state.dep ? found.dep_name : '';
  }

  function renderDepList(filter) {
    var dd = $('#depDD');
    var q = (filter || '').trim().toLowerCase();
    var list = (state.deps || [ALL_DEP]).filter(function (d) {
      if (!q) return true;
      return String(d.dep_name).toLowerCase().indexOf(q) >= 0 || String(d.dep_code).toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) { dd.innerHTML = '<div class="cb-empty">ไม่พบจุดบริการ</div>'; dd.classList.add('show'); return; }
    dd.innerHTML = list.map(function (d) {
      var cnt = d.visit_count === null || d.visit_count === undefined ? '' : UI.num(d.visit_count) + ' ราย';
      return '<div class="cb-item" data-code="' + esc(d.dep_code) + '" data-name="' + esc(d.dep_name) + '">' +
        '<span>' + esc(d.dep_name) + '</span><span class="cc">' + esc(cnt) + '</span></div>';
    }).join('');
    dd.classList.add('show');
    $$('#depDD .cb-item').forEach(function (el) {
      el.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        pickDep(el.dataset.code, el.dataset.name);
      });
    });
  }

  function pickDep(code, name) {
    state.dep = code;
    $('#depSel').value = code;
    $('#depSearch').value = code ? name : '';
    $('#depDD').classList.remove('show');
    refresh();
  }

  function bindDepCombo() {
    var inp = $('#depSearch');
    var dd = $('#depDD');
    inp.addEventListener('focus', function () { renderDepList(''); });
    inp.addEventListener('input', function () { renderDepList(inp.value); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { dd.classList.remove('show'); inp.blur(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        var first = dd.querySelector('.cb-item');
        if (first) pickDep(first.dataset.code, first.dataset.name);
      }
    });
    inp.addEventListener('blur', function () {
      setTimeout(function () {
        dd.classList.remove('show');
        // คืนข้อความให้ตรงกับค่าที่เลือกจริง (กันพิมพ์ค้างแล้วไม่ได้เลือก)
        var cur = state.dep;
        var found = (state.deps || []).filter(function (d) { return String(d.dep_code) === String(cur); })[0];
        inp.value = (cur && found) ? found.dep_name : '';
      }, 150);
    });
  }

  async function loadLookups() {
    try { state.lookups = await API.call('data.lookup', {}); } catch (e) { state.lookups = null; }
  }

  /* ================= รีเฟรชตามหน้า ================= */
  function loading(target) {
    target.innerHTML = '<div class="card card-pad"><div class="empty">' +
      '<div class="ico"><span class="spin dark" style="width:30px;height:30px;border-width:3px"></span></div>' +
      'กำลังโหลดข้อมูล…</div></div>';
  }

  async function refresh() {
    state.from = $('#dFrom').value || UI.todayStr();
    state.to = $('#dTo').value || state.from;
    state.dep = $('#depSel').value;
    state.status = $('#stSel').value;
    state.q = $('#qInput').value.trim();

    if (state.page === 'dashboard') {
      var t = $('#pageDashboard');
      loading(t);
      try {
        var r = await API.call('data.dashboard', params());
        renderDashboard(t, r);
      } catch (e) {
        if (guardExpiry(e)) return;
        t.innerHTML = errCard(e.message);
      }
    } else {
      var c = $('#pageCheck');
      loading(c);
      try {
        var d = await API.call('data.checklist', Object.assign(params(), { status: state.status, q: state.q }));
        state.checkFields = d.fields;
        renderCheck(c, d);
      } catch (e) {
        if (guardExpiry(e)) return;
        c.innerHTML = errCard(e.message);
      }
    }
  }

  function errCard(msg) {
    return '<div class="card card-pad"><div class="empty"><div class="ico">😿</div>' +
      '<div class="bold" style="color:#b04a63">เกิดข้อผิดพลาด</div>' +
      '<div class="small mt-8">' + esc(msg) + '</div></div></div>';
  }

  /* ================= หน้าแดชบอร์ด ================= */
  function renderDashboard(root, r) {
    var s = r.summary, a = r.added;
    var html = '';

    html += '<div class="stats">' +
      stat('ผู้รับบริการทั้งหมด', UI.num(s.total), 'ราย · ' + UI.thaiDate(r.from) + (r.from !== r.to ? ' – ' + UI.thaiDate(r.to) : ''), '👥', '') +
      stat('ข้อมูลครบถ้วน', UI.num(s.complete), pct(s.complete, s.total) + '% ของทั้งหมด', '✅', 'mint') +
      stat('ข้อมูลไม่ครบถ้วน', UI.num(s.incomplete), pct(s.incomplete, s.total) + '% ต้องเพิ่มข้อมูล', '⚠️', 'peach') +
      stat('ความสมบูรณ์เฉลี่ย', s.percent + '%', 'จาก ' + s.fields.length + ' ช่องที่ตรวจ', '💜', 'sky') +
      '</div>';

    html += '<div class="cols">';

    /* --- ความสมบูรณ์รายจุดบริการ --- */
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-title">🏥 ความสมบูรณ์รายจุดบริการ</div>' +
      '<span class="badge badge-violet">' + s.deps.length + ' จุดบริการ</span></div><div class="card-pad">';
    if (!s.deps.length) {
      html += '<div class="empty"><div class="ico">📭</div>ไม่พบข้อมูลผู้รับบริการในช่วงวันที่ที่เลือก</div>';
    } else {
      s.deps.forEach(function (d) {
        html += '<div class="brow">' +
          '<div class="nm" title="' + esc(d.dep_name) + '">' + esc(d.dep_name) + '</div>' +
          '<div class="bar ' + UI.tone(d.percent) + '"><span style="width:' + d.percent + '%"></span></div>' +
          '<div class="pc">' + d.percent + '% <span class="muted tiny">(' + UI.num(d.total) + ')</span></div>' +
          '</div>';
      });
      html += '<div class="table-wrap mt-14"><table class="tbl"><thead><tr>' +
        '<th>รหัส</th><th>จุดบริการ</th><th class="t-right">ทั้งหมด</th>' +
        '<th class="t-right">ครบ</th><th class="t-right">ไม่ครบ</th><th class="t-right">ความสมบูรณ์</th>' +
        '</tr></thead><tbody>';
      s.deps.forEach(function (d) {
        html += '<tr>' +
          '<td class="t-mono">' + esc(d.dep_code) + '</td>' +
          '<td>' + esc(d.dep_name) + '</td>' +
          '<td class="t-right">' + UI.num(d.total) + '</td>' +
          '<td class="t-right"><span class="badge badge-mint">' + UI.num(d.complete) + '</span></td>' +
          '<td class="t-right"><span class="badge ' + (d.incomplete ? 'badge-rose' : 'badge-gray') + '">' + UI.num(d.incomplete) + '</span></td>' +
          '<td class="t-right bold">' + d.percent + '%</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div></div>';

    /* --- รายการที่ขาดมากที่สุด --- */
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-title">🔎 รายการที่ยังลงไม่ครบ</div></div><div class="card-pad">';
    if (!s.total) {
      html += '<div class="empty"><div class="ico">🕊️</div>ยังไม่มีข้อมูลให้ตรวจสอบ</div>';
    } else {
      s.fields.forEach(function (it) {
        html += '<div class="brow">' +
          '<div class="nm" title="' + esc(it.label) + '">' + esc(it.label) + '</div>' +
          '<div class="bar ' + UI.tone(it.percent) + '"><span style="width:' + it.percent + '%"></span></div>' +
          '<div class="pc">' + it.percent + '%<br><span class="muted tiny">ขาด ' + UI.num(it.missing) + '</span></div>' +
          '</div>';
      });
    }
    html += '</div></div>';
    html += '</div>';

    /* --- ข้อมูลที่ลงเพิ่มผ่านระบบ --- */
    html += '<div class="card mt-20">' +
      '<div class="card-head"><div class="card-title">✍️ ข้อมูลที่ลงเพิ่มผ่านระบบ</div>' +
      '<span class="badge badge-violet">' + UI.num(a.fields) + ' รายการ / ' + UI.num(a.visits) + ' visit</span></div>';

    if (!a.entries) {
      html += '<div class="card-pad"><div class="empty"><div class="ico">🗒️</div>' +
        'ยังไม่มีการเพิ่มข้อมูลผ่านระบบในช่วงวันที่ที่เลือก<div class="small mt-8">' +
        'ไปที่เมนู “ตรวจสอบและเพิ่มข้อมูล” เพื่อเริ่มบันทึก</div></div></div>';
    } else {
      html += '<div class="card-pad" style="padding-bottom:6px"><div class="flex gap-14 wrap">';
      a.byUser.slice(0, 8).forEach(function (u) {
        html += '<span class="badge badge-sky">👤 ' + esc(u.key) + ' · ' + UI.num(u.count) + '</span>';
      });
      a.byField.slice(0, 10).forEach(function (f) {
        html += '<span class="badge badge-violet">' + esc(CHECK_LABEL[f.key] || f.key) + ' · ' + UI.num(f.count) + '</span>';
      });
      html += '</div></div>';
      html += '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th>เวลาบันทึก</th><th>VN</th><th>HN</th><th>ผู้ป่วย</th><th>จุดบริการ</th>' +
        '<th>ข้อมูลที่เพิ่ม</th><th>ผู้บันทึก</th></tr></thead><tbody>';
      a.recent.forEach(function (e) {
        html += '<tr>' +
          '<td class="nowrap small">' + esc(new Date(e.at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })) + '</td>' +
          '<td class="t-mono">' + esc(e.vn) + '</td>' +
          '<td class="t-mono">' + esc(e.hn) + '</td>' +
          '<td>' + esc(e.patient || '-') + '</td>' +
          '<td class="small">' + esc(e.dep_name || e.main_dep || '-') + '</td>' +
          '<td><div class="chips">' + (e.fields || []).map(function (f) {
            return '<span class="chip ok">' + esc(CHECK_LABEL[f] || f) + '</span>';
          }).join('') + '</div></td>' +
          '<td class="small">' + esc(e.userName || e.user || '-') + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';

    root.innerHTML = html;
  }

  function stat(label, val, foot, ico, kind) {
    return '<div class="stat ' + (kind || '') + '"><div class="ico">' + ico + '</div>' +
      '<div class="lb">' + esc(label) + '</div>' +
      '<div class="vl">' + val + '</div>' +
      '<div class="ft">' + esc(foot) + '</div></div>';
  }

  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }

  /* ================= หน้าตรวจสอบและเพิ่มข้อมูล (แก้ไขรายช่อง) ================= */

  // คอลัมน์แสดงอย่างเดียว
  var VIEW_COLS = [
    { key: 'oqueue', label: 'คิว', cls: 't-mono nowrap' },
    { key: 'vsttime', label: 'เวลา', cls: 'nowrap small', fmt: function (v) { return String(v || '').slice(0, 5); } },
    { key: 'hn', label: 'HN', cls: 't-mono' },
    { key: 'ptname', label: 'ชื่อผู้ป่วย', cls: 'nowrap' },
    { key: 'pttype_name', label: 'สิทธิ', cls: 'small', w: 215 },
    { key: 'ovstist_name', label: 'สถานะผู้ป่วย', cls: 'small' },
    { key: 'ost_name', label: 'ผลการรักษา', cls: 'small' },
    { key: 'doctor_name', label: 'แพทย์', cls: 'small', w: 240, editable: 'doctor' },
    { key: 'visit_type_name', label: 'ประเภท', cls: 'small' }
  ];
  // ฟิลด์แก้ไขได้ (ตามคิวรี่)
  var EDIT_COLS = [
    { key: 'hospmain', label: 'รพ.หลัก', type: 'text', w: 100 },
    { key: 'pdx', label: 'Pdx (ICD10)', type: 'icd10', w: 150 },
    { key: 'diagbtn', label: 'แก้ไข Diag', type: 'button', w: 110 },
    { key: 'cc', label: 'อาการสำคัญ (CC)', type: 'text', w: 170 },
    { key: 'bps', label: 'SBP', type: 'int', w: 66 },
    { key: 'bpd', label: 'DBP', type: 'int', w: 66 },
    { key: 'temperature', label: 'อุณหภูมิ', type: 'float', w: 78 },
    { key: 'bw', label: 'นน.', type: 'float', w: 72 },
    { key: 'height', label: 'ส่วนสูง', type: 'float', w: 78 },
    { key: 'bmi', label: 'BMI', type: 'float', w: 72 }
  ];

  function cellVal(v) { return (v === null || v === undefined) ? '' : String(v); }

  var RENDER_CAP = 400;   // วาดสูงสุดกี่แถวต่อครั้ง (กัน DOM หนักจนเบราว์เซอร์ค้าง)

  function renderCheck(root, d) {
    var allRows = d.rows;
    var rows = allRows.slice(0, RENDER_CAP);
    var s = d.summary;
    var html = '';

    // การ์ดสรุปอิงเฉพาะวันที่ + ห้องตรวจที่เลือก (ไม่แปรตามสถานะ/คำค้น)
    html += '<div class="stats">' +
      stat('รายการที่พบ', UI.num(s.total), 'ช่วงวันที่/จุดบริการที่เลือก', '📋', '') +
      stat('ยังไม่ครบถ้วน', UI.num(s.incomplete), 'มีช่องสีแดงต้องเติม', '⚠️', 'peach') +
      stat('ครบถ้วนแล้ว', UI.num(s.complete), 'ครบ ' + s.fields.length + ' ช่องที่ตรวจ', '✅', 'mint') +
      stat('ความสมบูรณ์เฉลี่ย', s.percent + '%', 'จาก ' + s.fields.length + ' ช่องต่อราย', '💜', 'sky') +
      '</div>';

    var filtered = d.total !== s.total;
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-title">📝 ตรวจสอบและเพิ่มข้อมูล' +
      (filtered ? ' <span class="badge badge-violet small" style="margin-left:6px">แสดง ' + UI.num(d.total) + ' / ' + UI.num(s.total) + ' ตามตัวกรอง</span>' : '') +
      '</div>' +
      '<span class="badge badge-rose small">🟥 ช่องสีแดง = ยังว่าง · แก้ในช่องแล้วกด Enter เพื่อบันทึกทันที</span></div>';

    if (!rows.length) {
      html += '<div class="card-pad"><div class="empty"><div class="ico">🎉</div>' +
        'ไม่พบรายการตามเงื่อนไขที่เลือก' +
        '<div class="small mt-8">ลองเปลี่ยนวันที่ จุดบริการ หรือสถานะข้อมูล</div></div></div>';
    } else {
      html += '<div class="table-wrap gridscroll" style="max-height:calc(100vh - 340px);overflow:auto">' +
        '<table class="tbl grid"><thead><tr>' +
        '<th class="nowrap">%</th>';
      VIEW_COLS.forEach(function (c) { html += '<th class="nowrap"' + (c.w ? ' style="min-width:' + c.w + 'px"' : '') + '>' + esc(c.label) + '</th>'; });
      EDIT_COLS.forEach(function (c) { html += '<th class="nowrap edit-h">' + esc(c.label) + '</th>'; });
      html += '<th class="nowrap">VN</th></tr></thead><tbody>';

      rows.forEach(function (r) {
        html += '<tr data-vn="' + esc(r.vn) + '">';
        html += '<td class="t-center nowrap"><span class="pcbadge ' + UI.tone(r._percent) + '">' + r._percent + '%</span></td>';
        VIEW_COLS.forEach(function (c) {
          if (c.editable === 'doctor') {
            var dname = cellVal(r.doctor_name);
            var dcode = cellVal(r.doctor_code);
            var dblank = dcode === '';
            html += '<td class="editcell doccell' + (dblank ? ' blank' : '') + '" style="min-width:' + c.w + 'px">' +
              '<input class="cin docin" data-vn="' + esc(r.vn) + '" data-field="doctor" data-code="' + esc(dcode) + '"' +
              ' value="' + esc(dname) + '" placeholder="ค้นหาแพทย์…" autocomplete="off">' +
              '</td>';
            return;
          }
          var val = c.fmt ? c.fmt(r[c.key]) : cellVal(r[c.key]);
          html += '<td class="' + c.cls + '"' + (c.w ? ' style="min-width:' + c.w + 'px"' : '') + '>' + esc(val || '-') + '</td>';
        });
        EDIT_COLS.forEach(function (c) {
          if (c.type === 'button') {
            html += '<td class="t-center" style="min-width:' + c.w + 'px">' +
              '<button class="btn btn-soft btn-sm diagbtn" data-vn="' + esc(r.vn) + '">✏️ แก้ไข Diag</button></td>';
            return;
          }
          var val = cellVal(r[c.key]);
          var blank = r._missing.indexOf(c.key) >= 0;   // สีแดงตามกฎฝั่งเซิร์ฟเวอร์ (รพ.หลักมีเงื่อนไขสิทธิ)
          var extra = c.key === 'pdx' ? (' title="' + esc(cellVal(r.pdx_name)) + '"') : '';
          html += '<td class="editcell' + (blank ? ' blank' : '') + '" style="min-width:' + c.w + 'px">' +
            '<input class="cin" data-vn="' + esc(r.vn) + '" data-field="' + c.key + '" data-type="' + c.type + '"' +
            ' value="' + esc(val) + '"' + (c.type === 'int' || c.type === 'float' ? ' inputmode="decimal"' : '') +
            (c.key === 'pdx' ? ' list="icdOptions" autocomplete="off"' : '') + extra + '>' +
            (c.key === 'pdx' ? '<div class="cin-sub">' + esc(cellVal(r.pdx_name)) + '</div>' : '') +
            '</td>';
        });
        html += '<td class="t-mono small">' + esc(r.vn) + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
      html += '<datalist id="icdOptions"></datalist>';
      if (d.total > rows.length) {
        html += '<div class="card-pad tiny muted t-center">⚡ แสดง ' + UI.num(rows.length) + ' จาก ' + UI.num(d.total) +
          ' รายการ (จำกัดเพื่อความลื่นไหล) — เลือก <b>จุดบริการ</b> หรือแคบ <b>ช่วงวันที่</b> ให้เจาะจงขึ้นเพื่อดูครบ</div>';
      }
    }
    html += '</div>';
    root.innerHTML = html;

    bindCells();
  }

  /* ---------- แก้ไขรายช่อง + บันทึกทันที ---------- */
  function bindCells() {
    var icdT = null;
    $$('#pageCheck input.cin').forEach(function (inp) {
      inp.dataset.orig = inp.value;

      // ช่องแพทย์: combobox ค้นหา + dropdown (จัดการแยก)
      if (inp.dataset.field === 'doctor') { bindDoctorCell(inp); return; }

      // ICD10: เติมตัวเลือกอัตโนมัติผ่าน datalist
      if (inp.dataset.field === 'pdx') {
        inp.addEventListener('input', function () {
          var q = inp.value.trim();
          clearTimeout(icdT);
          if (q.length < 2) return;
          icdT = setTimeout(async function () {
            try {
              var r = await API.call('data.icd10', { q: q });
              var dl = $('#icdOptions');
              if (dl) dl.innerHTML = r.items.map(function (i) {
                return '<option value="' + esc(i.code) + '">' + esc(i.code) + ' · ' + esc(i.name) + '</option>';
              }).join('');
            } catch (e) { /* เงียบ */ }
          }, 300);
        });
      }

      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        else if (e.key === 'Escape') { inp.value = inp.dataset.orig; inp.blur(); }
      });
      inp.addEventListener('blur', function () { commitCell(inp); });
    });

    // ปุ่มแก้ไข Diag
    $$('#pageCheck button.diagbtn').forEach(function (b) {
      b.addEventListener('click', function () { openDiagModal(b.dataset.vn); });
    });
  }

  /* ================= หน้าต่างแก้ไขการวินิจฉัย (ovstdiag) ================= */
  var DIAGTYPES = [
    { v: '1', t: '1 · Principal (วินิจฉัยหลัก)' },
    { v: '2', t: '2 · Comorbidity (โรคร่วม)' },
    { v: '3', t: '3 · Complication (โรคแทรก)' },
    { v: '4', t: '4 · Other (อื่นๆ)' },
    { v: '5', t: '5 · External cause' }
  ];
  function dtOptions(cur) {
    var c = (cur === null || cur === undefined) ? '' : String(cur);
    var known = DIAGTYPES.some(function (d) { return d.v === c; });
    var h = '';
    // ถ้าค่าใน ovstdiag.diagtype ไม่อยู่ในรายการมาตรฐาน ให้แสดงค่าจริงไว้ด้านบน (เลือกอยู่)
    if (c !== '' && !known) h += '<option value="' + esc(c) + '" selected>' + esc(c) + ' · (ค่าปัจจุบัน)</option>';
    h += DIAGTYPES.map(function (d) {
      return '<option value="' + d.v + '"' + (c === d.v ? ' selected' : '') + '>' + esc(d.t) + '</option>';
    }).join('');
    return h;
  }

  async function openDiagModal(vn) {
    var root = $('#modalRoot');
    root.innerHTML = '<div class="modal-back" id="dgBack"><div class="modal" style="max-width:720px">' +
      '<div class="modal-head"><div><h3 style="font-size:17px">แก้ไขการวินิจฉัย (Diag)</h3>' +
      '<div class="small muted">VN ' + esc(vn) + '</div></div>' +
      '<button class="x-btn" id="dgClose">✕</button></div>' +
      '<div class="modal-body" id="dgBody"><div class="empty"><span class="spin dark" style="width:26px;height:26px;border-width:3px"></span>' +
      '<div class="mt-8">กำลังโหลด…</div></div></div>' +
      '<div class="modal-foot"><span class="tiny muted" style="margin-right:auto">ข้อมูลจากตาราง ovstdiag</span>' +
      '<button class="btn btn-primary" id="dgDone">💾 บันทึก</button></div>' +
      '</div></div>';

    var changed = false;
    var defDoctor = { code: '', name: '' };   // แพทย์เริ่มต้นจาก ovst.doctor
    var close = function () { root.innerHTML = ''; if (changed) refresh(); };
    $('#dgClose').addEventListener('click', close);
    $('#dgDone').addEventListener('click', close);
    $('#dgBack').addEventListener('click', function (e) { if (e.target.id === 'dgBack') close(); });

    function render(diags) {
      var h = '';
      h += '<div class="flex items-center justify-between mb-8">' +
        '<div class="small muted">พบทั้งหมด <b>' + diags.length + '</b> รายการ</div></div>';
      h += '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th>#</th><th>ICD-10</th><th>ชื่อโรค</th><th style="min-width:200px">ประเภท</th><th>แพทย์</th><th></th>' +
        '</tr></thead><tbody id="dgRows">';
      if (!diags.length) {
        h += '<tr><td colspan="6"><div class="empty" style="padding:24px"><div class="ico">🩺</div>ยังไม่มีการวินิจฉัยของ VN นี้</div></td></tr>';
      } else {
        diags.forEach(function (d, idx) {
          h += '<tr>' +
            '<td class="t-mono muted">' + (idx + 1) + '</td>' +
            '<td class="t-mono bold">' + esc(d.icd10) + '</td>' +
            '<td class="small">' + esc(d.name || '-') + '</td>' +
            '<td><select class="select dg-dt" data-icd="' + esc(d.icd10) + '" data-old="' + esc(d.diagtype) + '">' + dtOptions(d.diagtype) + '</select></td>' +
            '<td style="min-width:180px"><input class="input dg-doc" data-icd="' + esc(d.icd10) + '" data-dt="' + esc(d.diagtype) + '" data-code="' + esc(d.doctor) + '" value="' + esc(d.doctor_name || d.doctor || '') + '" placeholder="ค้นหาแพทย์…" autocomplete="off"></td>' +
            '<td class="t-right"><button class="btn btn-ghost btn-sm dg-del" data-icd="' + esc(d.icd10) + '" data-dt="' + esc(d.diagtype) + '" title="ลบ">🗑️</button></td>' +
            '</tr>';
        });
      }
      h += '</tbody></table></div>';

      // เพิ่มการวินิจฉัยใหม่
      h += '<div class="sec-title" style="font-size:12.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--violet-600);margin:18px 0 12px">เพิ่มการวินิจฉัย</div>';
      h += '<div class="fgrid" style="display:grid;grid-template-columns:1.8fr 1fr 1.4fr auto;gap:10px;align-items:end">' +
        '<div class="field" style="margin:0"><label>ค้นหา ICD-10 / ชื่อโรค</label>' +
        '<div class="icd-wrap"><input class="input" id="dgIcd" placeholder="เช่น J00 หรือ ไข้หวัด" autocomplete="off">' +
        '<div class="icd-list" id="dgIcdList"></div></div><input type="hidden" id="dgIcdCode"></div>' +
        '<div class="field" style="margin:0"><label>ประเภท</label><select class="select" id="dgAddType">' + dtOptions('1') + '</select></div>' +
        '<div class="field" style="margin:0"><label>แพทย์</label>' +
        '<input class="input" id="dgAddDoc" placeholder="ค้นหาแพทย์…" autocomplete="off" value="' + esc(defDoctor.name || defDoctor.code || '') + '">' +
        '<input type="hidden" id="dgAddDocCode" value="' + esc(defDoctor.code || '') + '"></div>' +
        '<button class="btn btn-primary" id="dgAdd">➕ เพิ่ม</button>' +
        '</div>';

      $('#dgBody').innerHTML = h;
      bindRows();
    }

    function bindRows() {
      $$('#dgBody select.dg-dt').forEach(function (sel) {
        sel.addEventListener('change', async function () {
          try {
            var r = await API.call('diag.update', { vn: vn, icd10: sel.dataset.icd, oldType: sel.dataset.old, diagtype: sel.value });
            changed = true;
            UI.toast('เปลี่ยนประเภทแล้ว', sel.dataset.icd, 'ok', 1400);
            render(r.diags);
          } catch (e) { if (!guardExpiry(e)) UI.toast('แก้ไขไม่สำเร็จ', e.message, 'err'); }
        });
      });
      // แก้ไขแพทย์รายรายการ (combobox ค้นหา)
      $$('#dgBody input.dg-doc').forEach(function (inp) {
        bindDoctorSearch(inp, async function (code, name) {
          try {
            var r = await API.call('diag.doctor', { vn: vn, icd10: inp.dataset.icd, diagtype: inp.dataset.dt, doctor: code });
            changed = true;
            UI.toast('เปลี่ยนแพทย์แล้ว', name, 'ok', 1400);
            render(r.diags);
          } catch (e) { if (!guardExpiry(e)) UI.toast('แก้ไขแพทย์ไม่สำเร็จ', e.message, 'err', 5000); }
        });
      });

      $$('#dgBody button.dg-del').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!window.confirm('ลบการวินิจฉัย ' + b.dataset.icd + ' ?')) return;
          try {
            var r = await API.call('diag.delete', { vn: vn, icd10: b.dataset.icd, diagtype: b.dataset.dt });
            changed = true;
            UI.toast('ลบแล้ว', b.dataset.icd, 'ok', 1400);
            render(r.diags);
          } catch (e) { if (!guardExpiry(e)) UI.toast('ลบไม่สำเร็จ', e.message, 'err'); }
        });
      });

      // ค้นหา ICD-10
      var t = null;
      var inp = $('#dgIcd');
      inp.addEventListener('input', function () {
        var q = inp.value.trim();
        $('#dgIcdCode').value = '';
        clearTimeout(t);
        if (q.length < 2) { $('#dgIcdList').classList.remove('show'); return; }
        t = setTimeout(async function () {
          try {
            var r = await API.call('data.icd10', { q: q });
            var box = $('#dgIcdList');
            box.innerHTML = r.items.length ? r.items.map(function (i) {
              return '<div data-code="' + esc(i.code) + '"><b>' + esc(i.code) + '</b> · ' + esc(i.name) + '</div>';
            }).join('') : '<div class="muted">ไม่พบรหัส</div>';
            box.classList.add('show');
            $$('#dgIcdList div[data-code]').forEach(function (el) {
              el.addEventListener('click', function () {
                $('#dgIcdCode').value = el.dataset.code;
                inp.value = el.dataset.code + ' · ' + el.textContent.split('·').slice(1).join('·').trim();
                box.classList.remove('show');
              });
            });
          } catch (e) { /* เงียบ */ }
        }, 300);
      });
      document.addEventListener('click', function (e) {
        if (!e.target.closest('.icd-wrap')) { var b = $('#dgIcdList'); if (b) b.classList.remove('show'); }
      });

      // แพทย์สำหรับเพิ่ม — ค้นหาได้ (เติมจาก ovst.doctor ให้ก่อนแล้ว)
      bindDoctorSearch($('#dgAddDoc'), function (dcode, dname) {
        $('#dgAddDocCode').value = dcode;
        $('#dgAddDoc').value = dname;
        $('#dgAddDoc').dataset.orig = dname;
      });

      $('#dgAdd').addEventListener('click', async function () {
        var code = $('#dgIcdCode').value || $('#dgIcd').value.trim().split(' ')[0];
        if (!code) { UI.toast('ยังไม่ได้เลือก ICD-10', '', 'warn'); return; }
        UI.busy(this, true, 'กำลังเพิ่ม…');
        try {
          var r = await API.call('diag.add', { vn: vn, icd10: code, diagtype: $('#dgAddType').value, doctor: $('#dgAddDocCode').value });
          changed = true;
          if (r.duplicated) UI.toast('มีรหัสนี้อยู่แล้ว', code, 'warn');
          else UI.toast('เพิ่มการวินิจฉัยแล้ว', code, 'ok', 1400);
          render(r.diags);
        } catch (e) {
          if (!guardExpiry(e)) UI.toast('เพิ่มไม่สำเร็จ', e.message, 'err', 5000);
          UI.busy(this, false);
        }
      });
    }

    try {
      var d = await API.call('data.diags', { vn: vn });
      defDoctor = d.defaultDoctor || { code: '', name: '' };
      render(d.diags);
    } catch (e) {
      if (guardExpiry(e)) return;
      $('#dgBody').innerHTML = '<div class="empty"><div class="ico">😿</div>' + esc(e.message) + '</div>';
    }
  }

  async function commitCell(inp) {
    var val = inp.value.trim();
    if (val === inp.dataset.orig) return;                 // ไม่เปลี่ยน
    var td = inp.closest('td');

    // ช่องที่ "มีข้อมูลอยู่แล้ว" (ไม่แดง) → ยืนยันก่อนแก้ ; ช่องแดง (ว่าง) แก้ได้เลย
    if (!td.classList.contains('blank')) {
      var field = EDIT_COLS.filter(function (c) { return c.key === inp.dataset.field; })[0];
      var name = field ? field.label : inp.dataset.field;
      var okEdit = window.confirm(
        'ช่อง “' + name + '” มีข้อมูลอยู่แล้ว\n\n' +
        'เดิม : ' + (inp.dataset.orig || '(ว่าง)') + '\n' +
        'ใหม่ : ' + (val || '(ว่าง)') + '\n\n' +
        'ยืนยันการแก้ไขทับข้อมูลเดิมหรือไม่?');
      if (!okEdit) { inp.value = inp.dataset.orig; return; }   // ยกเลิก คืนค่าเดิม
    }

    inp.disabled = true;
    td.classList.add('saving');
    try {
      var r = await API.call('save.field', { vn: inp.dataset.vn, field: inp.dataset.field, value: val });
      inp.dataset.orig = inp.value = (r.value === null || r.value === undefined) ? val : String(r.value);
      td.classList.remove('blank', 'err');
      td.classList.add('saved');
      setTimeout(function () { td.classList.remove('saved'); }, 1200);
      if (r.row) applyRow(inp.dataset.vn, r.row);
    } catch (e) {
      if (guardExpiry(e)) return;
      td.classList.add('err');
      UI.toast('บันทึกไม่สำเร็จ', e.message, 'err', 5000);
      inp.value = inp.dataset.orig;
    } finally {
      inp.disabled = false;
      td.classList.remove('saving');
    }
  }

  /* ================= ช่องแพทย์ (combobox ค้นหา + dropdown) ================= */
  var docDD = null;         // dropdown ที่ใช้ร่วม (ลอยเหนือทุกอย่าง)
  var docActive = null;     // input แพทย์ที่กำลังเปิดอยู่
  var docTimer = null;

  function ensureDocDD() {
    if (docDD) return docDD;
    docDD = document.createElement('div');
    docDD.className = 'doc-dd';
    document.body.appendChild(docDD);
    document.addEventListener('click', function (e) {
      if (docActive && e.target !== docActive && !docDD.contains(e.target)) closeDocDD();
    });
    window.addEventListener('scroll', function () { if (docActive) closeDocDD(); }, true);
    window.addEventListener('resize', function () { if (docActive) closeDocDD(); });
    return docDD;
  }

  function positionDocDD(inp) {
    var r = inp.getBoundingClientRect();
    docDD.style.left = r.left + 'px';
    docDD.style.top = (r.bottom + 2) + 'px';
    docDD.style.width = Math.max(r.width, 260) + 'px';
  }

  function closeDocDD() {
    if (docDD) { docDD.classList.remove('show'); docDD.innerHTML = ''; }
    docActive = null;
  }

  async function loadDoctors(inp, onPick) {
    var dd = ensureDocDD();
    positionDocDD(inp);
    dd.classList.add('show');
    dd.innerHTML = '<div class="doc-empty">กำลังค้นหา…</div>';
    try {
      var r = await API.call('data.doctors', { q: inp.value.trim() });
      if (docActive !== inp) return;              // เปลี่ยนช่องไปแล้ว
      if (!r.items.length) { dd.innerHTML = '<div class="doc-empty">ไม่พบแพทย์ที่ค้นหา</div>'; return; }
      dd.innerHTML = r.items.map(function (d) {
        return '<div class="doc-item" data-code="' + esc(d.code) + '" data-name="' + esc(d.name) + '">' +
          '<span class="dn">' + esc(d.name) + '</span>' +
          '<span class="dl">' + (d.licenseno ? 'เลขที่ ' + esc(d.licenseno) : 'รหัส ' + esc(d.code)) + '</span>' +
          '</div>';
      }).join('');
      Array.prototype.forEach.call(dd.querySelectorAll('.doc-item'), function (el) {
        el.addEventListener('mousedown', function (ev) {    // mousedown ก่อน blur
          ev.preventDefault();
          closeDocDD();
          onPick(el.dataset.code, el.dataset.name);
        });
      });
    } catch (e) {
      if (docActive === inp) dd.innerHTML = '<div class="doc-empty">ค้นหาไม่สำเร็จ</div>';
    }
  }

  async function pickDoctor(inp, code, name) {
    if (String(code) === String(inp.dataset.code || '')) { inp.value = name; return; }  // ไม่เปลี่ยน
    var td = inp.closest('td');

    // มีแพทย์อยู่แล้ว (ไม่แดง) → ยืนยันก่อนแก้ ; ว่าง (แดง) → เปลี่ยนได้เลย
    if (!td.classList.contains('blank')) {
      var okEdit = window.confirm(
        'ช่อง “แพทย์” มีข้อมูลอยู่แล้ว\n\n' +
        'เดิม : ' + (inp.dataset.orig || '(ว่าง)') + '\n' +
        'ใหม่ : ' + name + '\n\n' +
        'ยืนยันการแก้ไขทับข้อมูลเดิมหรือไม่?');
      if (!okEdit) { inp.value = inp.dataset.orig; return; }
    }

    inp.disabled = true; td.classList.add('saving');
    try {
      await API.call('save.field', { vn: inp.dataset.vn, field: 'doctor', value: code });
      inp.dataset.code = String(code);
      inp.dataset.orig = inp.value = name;
      td.classList.remove('blank', 'err');
      td.classList.add('saved');
      setTimeout(function () { td.classList.remove('saved'); }, 1200);
      UI.toast('บันทึกแพทย์แล้ว', name, 'ok', 1600);
    } catch (e) {
      if (guardExpiry(e)) return;
      td.classList.add('err');
      UI.toast('บันทึกไม่สำเร็จ', e.message, 'err', 5000);
      inp.value = inp.dataset.orig;
    } finally {
      inp.disabled = false; td.classList.remove('saving');
    }
  }

  function bindDoctorCell(inp) {
    inp.dataset.orig = inp.value;
    var onPick = function (code, name) { pickDoctor(inp, code, name); };
    inp.addEventListener('focus', function () { docActive = inp; loadDoctors(inp, onPick); });
    inp.addEventListener('input', function () {
      docActive = inp;
      clearTimeout(docTimer);
      docTimer = setTimeout(function () { loadDoctors(inp, onPick); }, 250);
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { inp.value = inp.dataset.orig; closeDocDD(); inp.blur(); }
    });
    inp.addEventListener('blur', function () {
      // ปิด dropdown และคืนชื่อเดิมถ้าไม่ได้เลือกจากรายการ (ต้องเลือกเพื่อให้ได้รหัส)
      setTimeout(function () {
        if (inp.value !== inp.dataset.orig) inp.value = inp.dataset.orig;
        if (docActive === inp) closeDocDD();
      }, 150);
    });
  }

  /** ผูก combobox ค้นหาแพทย์แบบทั่วไป (ใช้ในหน้าต่างแก้ไข Diag) — onPick(code,name) */
  function bindDoctorSearch(inp, onPick) {
    inp.dataset.orig = inp.value;
    var pick = function (code, name) { onPick(code, name); };
    inp.addEventListener('focus', function () { docActive = inp; loadDoctors(inp, pick); });
    inp.addEventListener('input', function () {
      docActive = inp;
      clearTimeout(docTimer);
      docTimer = setTimeout(function () { loadDoctors(inp, pick); }, 250);
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { inp.value = inp.dataset.orig; closeDocDD(); inp.blur(); }
    });
    inp.addEventListener('blur', function () {
      setTimeout(function () {
        if (inp.value !== inp.dataset.orig) inp.value = inp.dataset.orig;
        if (docActive === inp) closeDocDD();
      }, 150);
    });
  }

  /** อัปเดตค่าในแถวหลังบันทึก (เปอร์เซ็นต์ + ชื่อ Pdx + สถานะ blank) */
  function applyRow(vn, row) {
    var tr = document.querySelector('#pageCheck tr[data-vn="' + cssEsc(vn) + '"]');
    if (!tr) return;
    var badge = tr.querySelector('.pcbadge');
    if (badge) { badge.textContent = row._percent + '%'; badge.className = 'pcbadge ' + UI.tone(row._percent); }
    EDIT_COLS.forEach(function (c) {
      var cell = tr.querySelector('input.cin[data-field="' + c.key + '"]');
      if (!cell) return;
      var td = cell.closest('td');
      var blank = row._missing.indexOf(c.key) >= 0;
      td.classList.toggle('blank', blank);
      if (c.key === 'pdx') {
        var sub = td.querySelector('.cin-sub');
        if (sub) sub.textContent = cellVal(row.pdx_name);
        cell.title = cellVal(row.pdx_name);
      }
    });
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }


  boot();
})();
