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
    deps: [],
    dentalLk: null,
    physioType: 'all',
    physioData: null,
    physioFinishMode: false,
    ancMode: 'all',
    ancData: null,
    ipdBasis: 'stay',
    ipdWard: '',
    ipdMiss: '',
    ipdData: null
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

  var PAGE_TITLE = {
    dashboard: 'แดชบอร์ดข้อมูลที่ลงเพิ่ม',
    check: 'ตรวจสอบและเพิ่มข้อมูล OPD',
    dental: 'ตรวจข้อมูลทันตกรรม',
    physio: 'งานกายภาพบำบัด',
    anc: 'งานฝากครรภ์',
    ipd: 'ผู้ป่วยใน'
  };
  var PAGE_SUB = {
    dashboard: 'ภาพรวมความสมบูรณ์ของข้อมูลผู้รับบริการ และรายการที่ลงเพิ่มผ่านระบบ',
    check: 'ตรวจสอบรายการที่ข้อมูลไม่ครบ และบันทึกข้อมูลเพิ่มเติมเข้าฐานข้อมูล',
    dental: 'ตรวจสอบความครบถ้วนของข้อมูลทันตกรรม (dental_care) — ช่องว่างแดงแก้ได้ทันที',
    physio: 'ตรวจสอบและเพิ่มข้อมูลงานกายภาพบำบัด',
    anc: 'ตรวจสอบความครบถ้วนงานฝากครรภ์ (PRENATAL / ANC / คลอด / หลังคลอด) — ช่องว่างแดงแก้ได้ทันที',
    ipd: 'ตรวจสอบตามโครงสร้าง 43 แฟ้ม (ADMISSION / DIAGNOSIS / DRUG / PROCEDURE / CHARGE_IPD) + เงื่อนไขกองทุน — ช่องแดงแก้ได้ทันที'
  };

  function go(page) {
    state.page = page;
    $$('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.page === page); });
    var dash = page === 'dashboard';
    $('#pageDashboard').classList.toggle('hidden', page !== 'dashboard');
    $('#pageCheck').classList.toggle('hidden', page !== 'check');
    $('#pageDental').classList.toggle('hidden', page !== 'dental');
    $('#pagePhysio').classList.toggle('hidden', page !== 'physio');
    $('#pageAnc').classList.toggle('hidden', page !== 'anc');
    $('#pageIpd').classList.toggle('hidden', page !== 'ipd');
    $('#fgDep').classList.toggle('hidden', page === 'ipd');   // ผู้ป่วยในใช้ตัวเลือก ward ในหน้าแทน
    // เข้าหน้าผู้ป่วยในครั้งแรก → แสดงทุกคนใน ward (ไม่กรองเฉพาะที่ยังไม่ครบ)
    if (page === 'ipd' && !state.ipdVisited) { state.ipdVisited = true; $('#stSel').value = ''; }
    $('#fgStatus').classList.toggle('hidden', dash);
    $('#fgSearch').classList.toggle('hidden', dash);
    $('#pageTitle').textContent = PAGE_TITLE[page] || '';
    $('#pageSub').textContent = PAGE_SUB[page] || '';
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
    } else if (state.page === 'physio') {
      var pp = $('#pagePhysio');
      loading(pp);
      try {
        var pd = await API.call('data.physiocheck', Object.assign(params(), { status: state.status, q: state.q }));
        renderPhysio(pp, pd);
      } catch (e) {
        if (guardExpiry(e)) return;
        pp.innerHTML = errCard(e.message);
      }
    } else if (state.page === 'anc') {
      var ap = $('#pageAnc');
      loading(ap);
      try {
        var ad = await API.call('data.anccheck', Object.assign(params(), { mode: state.ancMode, status: state.status, q: state.q }));
        renderAnc(ap, ad);
      } catch (e) {
        if (guardExpiry(e)) return;
        ap.innerHTML = errCard(e.message);
      }
    } else if (state.page === 'ipd') {
      var ip = $('#pageIpd');
      loading(ip);
      try {
        var id = await API.call('data.ipdcheck', {
          from: state.from, to: state.to, basis: state.ipdBasis, ward: state.ipdWard,
          miss: state.ipdMiss, status: state.status, q: state.q
        });
        renderIpd(ip, id);
      } catch (e) {
        if (guardExpiry(e)) return;
        ip.innerHTML = errCard(e.message);
      }
    } else if (state.page === 'dental') {
      var dt = $('#pageDental');
      loading(dt);
      try {
        if (!state.dentalLk) { try { state.dentalLk = (await API.call('data.dentallookups', {})).lookups; } catch (e2) { state.dentalLk = {}; } }
        var dd2 = await API.call('data.dentalcheck', Object.assign(params(), { status: state.status, q: state.q }));
        renderDental(dt, dd2);
      } catch (e) {
        if (guardExpiry(e)) return;
        dt.innerHTML = errCard(e.message);
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
        'ไปที่เมนู “ตรวจสอบและเพิ่มข้อมูล OPD” เพื่อเริ่มบันทึก</div></div></div>';
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

  // เปิดหน้า EMR ของโปรเจกต์นี้ (same-origin) ในแท็บใหม่
  function openEmr(vn) {
    try { window.open('/emr.html?vn=' + encodeURIComponent(vn), '_blank'); } catch (e) {}
  }

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
      '<div class="card-head"><div class="card-title">📝 ตรวจสอบและเพิ่มข้อมูล OPD' +
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
        '<th class="nowrap">EMR</th>' +
        '<th class="nowrap">%</th>';
      VIEW_COLS.forEach(function (c) { html += '<th class="nowrap"' + (c.w ? ' style="min-width:' + c.w + 'px"' : '') + '>' + esc(c.label) + '</th>'; });
      EDIT_COLS.forEach(function (c) { html += '<th class="nowrap edit-h">' + esc(c.label) + '</th>'; });
      html += '<th class="nowrap">ผู้บันทึกเพิ่มเติม</th><th class="nowrap">VN</th></tr></thead><tbody>';

      rows.forEach(function (r) {
        html += '<tr data-vn="' + esc(r.vn) + '">';
        html += '<td class="t-center nowrap"><button class="btn btn-emr emrbtn" data-vn="' + esc(r.vn) + '" title="เปิด EMR ของ VN นี้">📄 EMR</button></td>';
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
        html += '<td class="nowrap small">' + (cellVal(r.app_staff_name) ? esc(cellVal(r.app_staff_name)) : '<span class="muted">-</span>') + '</td>';
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
    // ปุ่ม EMR → เปิดหน้าใหม่ emr.html?vn=
    $$('#pageCheck button.emrbtn').forEach(function (b) {
      b.addEventListener('click', function () { openEmr(b.dataset.vn); });
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

  /* ================= หน้าตรวจข้อมูลทันตกรรม (dental_care) ================= */
  var DENTAL_VIEW = [
    { key: 'reccount', label: 'ลำดับ', cls: 't-center nowrap' },
    { key: 'vstdate', label: 'วันที่', cls: 'nowrap small', fmt: function (v) { return UI.thaiDate(v); } },
    { key: 'hn', label: 'HN', cls: 't-mono' },
    { key: 'ptname', label: 'ชื่อผู้ป่วย', cls: 'nowrap' },
    { key: 'cid', label: 'เลขบัตร ปชช.', cls: 't-mono small' }
  ];

  function dentalOptions(lookup, cur) {
    var list = (state.dentalLk && state.dentalLk[lookup]) || [];
    var c = (cur === null || cur === undefined) ? '' : String(cur);
    var h = '<option value="">— เลือก —</option>';
    var known = false;
    list.forEach(function (o) {
      if (String(o.code) === c) known = true;
      h += '<option value="' + esc(o.code) + '"' + (String(o.code) === c ? ' selected' : '') + '>' + esc(o.code) + ' · ' + esc(o.name) + '</option>';
    });
    if (c !== '' && !known) h = '<option value="' + esc(c) + '" selected>' + esc(c) + ' · (ค่าปัจจุบัน)</option>' + h;
    return h;
  }

  function renderDental(root, d) {
    var fields = d.fields;
    state.dentalFields = fields;
    var allRows = d.rows;
    state.dentalRows = allRows;
    var rows = allRows.slice(0, 400);
    var s = d.summary;
    var html = '';

    html += '<div class="stats">' +
      stat('รายการทันตกรรม', UI.num(s.total), 'ช่วงวันที่/จุดบริการที่เลือก', '🦷', '') +
      stat('ยังไม่ครบถ้วน', UI.num(s.incomplete), 'มีช่องสีแดงต้องเติม', '⚠️', 'peach') +
      stat('ครบถ้วนแล้ว', UI.num(s.complete), 'ครบ ' + fields.length + ' ช่องที่ตรวจ', '✅', 'mint') +
      stat('ความสมบูรณ์เฉลี่ย', s.percent + '%', 'จาก ' + fields.length + ' ช่องต่อราย', '💜', 'sky') +
      '</div>';

    var filtered = d.total !== s.total;
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-title">🦷 ตรวจข้อมูลทันตกรรม' +
      (filtered ? ' <span class="badge badge-violet small" style="margin-left:6px">แสดง ' + UI.num(d.total) + ' / ' + UI.num(s.total) + ' ตามตัวกรอง</span>' : '') +
      '</div>' +
      '<div class="flex items-center gap-10">' +
      '<button class="btn btn-primary btn-sm" id="btnDentalFill">🩹 อัพเดทข้อมูลที่ขาด</button>' +
      '<span class="badge badge-rose small">🟥 ช่องสีแดง = ยังว่าง · แก้ในช่องแล้วบันทึกทันที</span></div></div>';

    if (!rows.length) {
      html += '<div class="card-pad"><div class="empty"><div class="ico">🦷</div>' +
        'ไม่พบรายการทันตกรรมตามเงื่อนไขที่เลือก' +
        '<div class="small mt-8">ลองเปลี่ยนวันที่ จุดบริการ หรือสถานะข้อมูล</div></div></div>';
    } else {
      html += '<div class="table-wrap gridscroll" style="max-height:calc(100vh - 340px);overflow:auto">' +
        '<table class="tbl grid"><thead><tr>' +
        '<th class="nowrap">%</th>';
      DENTAL_VIEW.forEach(function (c) { html += '<th class="nowrap">' + esc(c.label) + '</th>'; });
      fields.forEach(function (f) { html += '<th class="nowrap edit-h">' + esc(f.label) + '</th>'; });
      html += '<th class="nowrap">VN</th></tr></thead><tbody>';

      rows.forEach(function (r) {
        html += '<tr data-vn="' + esc(r.vn) + '">';
        html += '<td class="t-center nowrap"><span class="pcbadge ' + UI.tone(r._percent) + '">' + r._percent + '%</span></td>';
        DENTAL_VIEW.forEach(function (c) {
          var val = c.fmt ? c.fmt(r[c.key]) : cellVal(r[c.key]);
          html += '<td class="' + c.cls + '">' + esc(val || '-') + '</td>';
        });
        fields.forEach(function (f) {
          var blank = r._missing.indexOf(f.key) >= 0;
          var w = 'min-width:' + (f.w || 90) + 'px';
          if (f.ro) {   // อ่านอย่างเดียว: แสดงชื่อแทนรหัส (เช่น ผู้ให้บริการ = ชื่อแพทย์)
            var disp = (f.nameKey ? cellVal(r[f.nameKey]) : '') || cellVal(r[f.key]);
            html += '<td class="small' + (blank ? ' rored' : '') + '" style="' + w + '"' +
              (cellVal(r[f.key]) && f.nameKey ? ' title="รหัส ' + esc(cellVal(r[f.key])) + '"' : '') + '>' +
              esc(disp || '-') + '</td>';
            return;
          }
          if (f.type === 'fk') {
            html += '<td class="editcell dcell' + (blank ? ' blank' : '') + '" style="' + w + '">' +
              '<select class="select dcin" data-vn="' + esc(r.vn) + '" data-field="' + f.key + '" data-type="fk">' +
              dentalOptions(f.lookup, r[f.key]) + '</select></td>';
          } else if (f.type === 'chk') {
            var cv = (r[f.key] === null || r[f.key] === undefined || String(r[f.key]) === '') ? '' : (Number(r[f.key]) ? '1' : '0');
            html += '<td class="editcell dcell' + (blank ? ' blank' : '') + '" style="' + w + '">' +
              '<select class="select dcin" data-vn="' + esc(r.vn) + '" data-field="' + f.key + '" data-type="chk">' +
              '<option value=""' + (cv === '' ? ' selected' : '') + '>—</option>' +
              '<option value="1"' + (cv === '1' ? ' selected' : '') + '>ใช่</option>' +
              '<option value="0"' + (cv === '0' ? ' selected' : '') + '>ไม่</option>' +
              '</select></td>';
          } else {
            var t = f.type === 'int' ? 'number' : 'text';
            html += '<td class="editcell dcell' + (blank ? ' blank' : '') + '" style="' + w + '">' +
              '<input class="cin dcin" type="' + t + '" data-vn="' + esc(r.vn) + '" data-field="' + f.key + '" data-type="' + f.type + '"' +
              (f.type === 'int' ? ' inputmode="numeric"' : '') + ' value="' + esc(cellVal(r[f.key])) + '"></td>';
          }
        });
        html += '<td class="t-mono small">' + esc(r.vn) + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
      if (d.total > rows.length) {
        html += '<div class="card-pad tiny muted t-center">⚡ แสดง ' + UI.num(rows.length) + ' จาก ' + UI.num(d.total) +
          ' รายการ — เลือกจุดบริการหรือแคบช่วงวันที่เพื่อดูครบ</div>';
      }
    }
    html += '</div>';
    root.innerHTML = html;
    bindDentalCells();
  }

  function bindDentalCells() {
    var fill = $('#btnDentalFill');
    if (fill) fill.addEventListener('click', openDentalFillModal);
    // select (fk/chk) → บันทึกเมื่อ change
    $$('#pageDental select.dcin').forEach(function (sel) {
      sel.dataset.orig = sel.value;
      sel.addEventListener('change', function () { commitDental(sel); });
    });
    // input (int/text) → บันทึกเมื่อ Enter/blur
    $$('#pageDental input.dcin').forEach(function (inp) {
      inp.dataset.orig = inp.value;
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        else if (e.key === 'Escape') { inp.value = inp.dataset.orig; inp.blur(); }
      });
      inp.addEventListener('blur', function () { commitDental(inp); });
    });
  }

  async function commitDental(el) {
    var val = String(el.value).trim();
    if (val === (el.dataset.orig || '')) return;
    var td = el.closest('td');

    // ช่องที่มีข้อมูลอยู่แล้ว (ไม่แดง) → ยืนยันก่อนแก้ทับ ; ช่องแดง → บันทึกเลย
    if (!td.classList.contains('blank')) {
      var okEdit = window.confirm('ช่องนี้มีข้อมูลอยู่แล้ว\n\nเดิม : ' + (el.dataset.orig || '(ว่าง)') + '\nใหม่ : ' + (val || '(ว่าง)') + '\n\nยืนยันการแก้ไขทับข้อมูลเดิมหรือไม่?');
      if (!okEdit) { el.value = el.dataset.orig; return; }
    }

    el.disabled = true; td.classList.add('saving');
    try {
      var r = await API.call('save.dentalfield', { vn: el.dataset.vn, field: el.dataset.field, value: val });
      el.dataset.orig = el.value = (r.value === null || r.value === undefined) ? val : String(r.value);
      td.classList.remove('blank', 'err');
      td.classList.add('saved');
      setTimeout(function () { td.classList.remove('saved'); }, 1200);
      if (r.row) applyDentalRow(el.dataset.vn, r.row);
    } catch (e) {
      if (guardExpiry(e)) return;
      td.classList.add('err');
      UI.toast('บันทึกไม่สำเร็จ', e.message, 'err', 5000);
      el.value = el.dataset.orig;
    } finally {
      el.disabled = false; td.classList.remove('saving');
    }
  }

  function applyDentalRow(vn, row) {
    var tr = document.querySelector('#pageDental tr[data-vn="' + cssEsc(vn) + '"]');
    if (!tr) return;
    var badge = tr.querySelector('.pcbadge');
    if (badge) { badge.textContent = row._percent + '%'; badge.className = 'pcbadge ' + UI.tone(row._percent); }
    (state.dentalFields || []).forEach(function (f) {
      var cell = tr.querySelector('.dcin[data-field="' + f.key + '"]');
      if (!cell) return;
      var td = cell.closest('td');
      td.classList.toggle('blank', row._missing.indexOf(f.key) >= 0);
    });
  }

  /* ---------- อัพเดทข้อมูลที่ขาด (เติมค่าเริ่มต้นตาม vn) ---------- */
  function openDentalFillModal() {
    var incomplete = (state.dentalRows || []).filter(function (r) { return !r._complete; });
    var root = $('#modalRoot');

    if (!incomplete.length) {
      UI.toast('ไม่มีรายการที่ไม่ครบถ้วน', 'ทุกคนในรายการที่แสดงข้อมูลครบแล้ว', 'ok');
      return;
    }

    var rowsHtml = incomplete.map(function (r) {
      return '<tr>' +
        '<td class="t-center"><input type="checkbox" class="dfchk" data-vn="' + esc(r.vn) + '" checked></td>' +
        '<td class="t-mono">' + esc(r.hn) + '</td>' +
        '<td>' + esc(r.ptname || '-') + '</td>' +
        '<td class="small nowrap">' + UI.thaiDate(r.vstdate) + '</td>' +
        '<td class="t-center"><span class="pcbadge ' + UI.tone(r._percent) + '">' + r._percent + '%</span></td>' +
        '<td class="t-center small muted">ขาด ' + r._missing.length + '</td>' +
        '<td class="t-mono small">' + esc(r.vn) + '</td></tr>';
    }).join('');

    root.innerHTML = '<div class="modal-back" id="dfBack"><div class="modal" style="max-width:760px">' +
      '<div class="modal-head"><div><h3 style="font-size:17px">อัพเดทข้อมูลที่ขาด</h3>' +
      '<div class="small muted">เติมค่าเริ่มต้นให้ช่องที่ว่าง เฉพาะรายที่ติ๊ก (ไม่สนวันที่)</div></div>' +
      '<button class="x-btn" id="dfClose">✕</button></div>' +
      '<div class="modal-body">' +
      '<div class="flex items-center justify-between mb-8">' +
      '<label class="flex items-center gap-6" style="cursor:pointer"><input type="checkbox" id="dfAll" checked> <span class="small bold">เลือกทั้งหมด</span></label>' +
      '<span class="small muted">พบไม่ครบถ้วน <b id="dfCount">' + incomplete.length + '</b> ราย</span></div>' +
      '<div class="table-wrap" style="max-height:52vh;overflow:auto"><table class="tbl"><thead><tr>' +
      '<th class="t-center">เลือก</th><th>HN</th><th>ชื่อผู้ป่วย</th><th>วันที่</th><th class="t-center">%</th><th class="t-center">ช่องขาด</th><th>VN</th>' +
      '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div>' +
      '<div class="modal-foot"><span class="tiny muted" style="margin-right:auto">เติม: สถานที่บริการ, จำนวนฟัน/รักษาที่เป็นค่าว่างหรือติดลบ = 0, สภาวะปริทันต์ = 9</span>' +
      '<button class="btn btn-ghost" id="dfCancel">ยกเลิก</button>' +
      '<button class="btn btn-primary" id="dfRun">⚙️ จัดการอัพเดทข้อมูล</button></div>' +
      '</div></div>';

    var close = function () { root.innerHTML = ''; };
    $('#dfClose').addEventListener('click', close);
    $('#dfCancel').addEventListener('click', close);
    $('#dfBack').addEventListener('click', function (e) { if (e.target.id === 'dfBack') close(); });

    $('#dfAll').addEventListener('change', function () {
      var on = this.checked;
      $$('#modalRoot .dfchk').forEach(function (c) { c.checked = on; });
    });

    $('#dfRun').addEventListener('click', async function () {
      var vns = $$('#modalRoot .dfchk').filter(function (c) { return c.checked; }).map(function (c) { return c.dataset.vn; });
      if (!vns.length) { UI.toast('ยังไม่ได้เลือกรายการ', '', 'warn'); return; }
      if (!window.confirm('อัพเดทข้อมูลที่ขาดของ ' + vns.length + ' ราย?')) return;
      UI.busy(this, true, 'กำลังอัพเดท…');
      try {
        var r = await API.call('save.dentalfill', { vns: vns });
        var msg = 'แก้ไข ' + UI.num(r.affected) + ' ค่า จาก ' + vns.length + ' ราย';
        if (r.created) msg += ' · สร้างระเบียนใหม่ ' + r.created + ' ราย';
        if (r.createFail) msg += ' · สร้างไม่ได้ ' + r.createFail + ' ราย';
        UI.toast('อัพเดทข้อมูลแล้ว', msg, r.createFail ? 'warn' : 'ok', 6000);
        if (r.createErr) UI.toast('สร้างระเบียน dental_care ไม่สำเร็จ', r.createErr, 'err', 12000);
        close();
        refresh();
      } catch (e) {
        if (guardExpiry(e)) return;
        UI.toast('อัพเดทไม่สำเร็จ', e.message, 'err', 6000);
        UI.busy(this, false);
      }
    });
  }

  /* ================= หน้างานฝากครรภ์ (person_anc / service / preg_care) ================= */
  var ANC_MODES = [
    { key: 'all',       label: '🔗 รวมทุกงาน' },
    { key: 'prenatal',  label: '🤰 ฝากครรภ์' },
    { key: 'anc',       label: '📅 มาตามนัด (ANC)' },
    { key: 'labor',     label: '🍼 คลอด' },
    { key: 'postnatal', label: '👩‍🍼 ดูแลหลังคลอด' }
  ];

  function renderAnc(root, d) {
    state.ancData = d;
    var mode = d.mode || state.ancMode || 'prenatal';
    var fields = d.fields || [];
    var rows = (d.rows || []).slice(0, 500);
    var ss = d.summary || { total: 0, complete: 0, incomplete: 0, percent: 0, fields: 0 };
    var showGravida = !fields.some(function (f) { return f.key === 'gravida'; });  // ถ้าครรภ์ที่เป็นฟิลด์แก้ไขแล้ว ไม่ต้องโชว์ซ้ำ
    var showVn = (mode === 'anc' || mode === 'postnatal' || mode === 'all');
    var showAncCount = (mode === 'all');

    // แถบสลับโหมด
    var seg = ANC_MODES.map(function (m) {
      return '<button class="btn btn-sm ' + (m.key === mode ? 'btn-primary' : 'btn-soft') + ' aseg" data-mode="' + m.key + '">' + esc(m.label) + '</button>';
    }).join('');

    var html = '';
    html += '<div class="stats">' +
      stat('รายการ' + (ss.total ? '' : ''), UI.num(ss.total), 'จำนวนระเบียนในช่วงวันที่', '🤰', '') +
      stat('ยังไม่ครบถ้วน', UI.num(ss.incomplete), 'มีช่องสีแดงต้องเติม', '⚠️', 'peach') +
      stat('ครบถ้วนแล้ว', UI.num(ss.complete), 'ครบ ' + (ss.fields || 0) + ' ช่องที่ตรวจ', '✅', 'mint') +
      stat('ความสมบูรณ์เฉลี่ย', ss.percent + '%', 'จาก ' + (ss.fields || 0) + ' ช่องต่อราย', '💜', 'sky') +
      '</div>';

    html += '<div class="card">' +
      '<div class="card-head"><div class="card-title">🤰 งานฝากครรภ์' +
      (d.grandTotal > rows.length ? ' <span class="badge badge-violet small" style="margin-left:6px">แสดง ' + UI.num(rows.length) + ' / ' + UI.num(d.grandTotal) + '</span>' : '') +
      '</div>' + seg +
      '<span class="badge badge-rose small">🟥 ช่องสีแดง = ควรบันทึกแต่ยังว่าง · แก้ในช่องแล้วบันทึกทันที</span></div>';

    if (!rows.length) {
      html += '<div class="card-pad"><div class="empty"><div class="ico">🤰</div>' +
        'ไม่พบข้อมูลงานฝากครรภ์ตามเงื่อนไขที่เลือก' +
        '<div class="small mt-8">ลองเปลี่ยนช่วงวันที่ หรือสลับโหมดด้านบน</div></div></div>';
    } else {
      html += '<div class="table-wrap gridscroll" style="max-height:calc(100vh - 340px);overflow:auto">' +
        '<table class="tbl grid"><thead><tr><th class="nowrap">%</th>' +
        '<th class="nowrap">วันที่</th><th class="nowrap">HN</th><th class="nowrap">ชื่อผู้ป่วย</th>' +
        (showGravida ? '<th class="nowrap">ครรภ์ที่</th>' : '') +
        (showAncCount ? '<th class="nowrap">ANC(ครั้ง)</th>' : '') +
        (showVn ? '<th class="nowrap">VN' + (mode === 'all' ? ' (ล่าสุด)' : '') + '</th>' : '');
      fields.forEach(function (f) { html += '<th class="nowrap edit-h">' + esc(f.label) + '</th>'; });
      html += '</tr></thead><tbody>';

      rows.forEach(function (r) {
        var ctx = r._ctx || {};
        var dataAttrs = ' data-key="' + esc(r.key) + '"' +
          ' data-anc="' + esc(cellVal(ctx.ancId)) + '" data-person="' + esc(cellVal(ctx.personId)) + '"' +
          ' data-svc="' + esc(cellVal(ctx.svcId)) + '" data-care="' + esc(cellVal(ctx.careId)) + '"' +
          ' data-vn="' + esc(cellVal(ctx.vn)) + '" data-hn="' + esc(cellVal(ctx.hn)) + '"';
        html += '<tr data-key="' + esc(r.key) + '">';
        html += '<td class="t-center nowrap"><span class="pcbadge ' + UI.tone(r._percent) + '">' + r._percent + '%</span></td>';
        html += '<td class="nowrap small">' + esc(UI.thaiDate(r.vstdate) || '-') + '</td>';
        html += '<td class="t-mono">' + esc(cellVal(r.hn) || '-') + '</td>';
        html += '<td class="nowrap">' + esc(cellVal(r.ptname) || '-') + '</td>';
        if (showGravida) html += '<td class="t-center">' + esc(cellVal(r.gravida) || '-') + '</td>';
        if (showAncCount) html += '<td class="t-center small">' + esc(cellVal(r.anc_count) || '0') + '</td>';
        if (showVn) html += '<td class="t-mono small">' + esc(cellVal(r.vn) || '-') + '</td>';

        fields.forEach(function (f) {
          var blank = (r._missing || []).indexOf(f.key) >= 0;
          var w = 'min-width:' + (f.w || 100) + 'px';
          // แก้ไขได้เมื่อมีคีย์ต้นทาง (เช่น ANC/หลังคลอด ต้องมี svcId/careId ล่าสุด, น้ำหนักต้องมี vn)
          var canEdit = !f.keyReq || (cellVal(ctx[f.keyReq]).trim() !== '');
          if (canEdit) {
            var t = f.type === 'date' ? 'date' : ((f.type === 'int' || f.type === 'float') ? 'number' : 'text');
            html += '<td class="editcell acell' + (blank ? ' blank' : '') + '" style="' + w + '">' +
              '<input class="cin acin" type="' + t + '" data-field="' + f.key + '"' + dataAttrs +
              ' value="' + esc(cellVal(r[f.key])) + '"></td>';
          } else {
            var disp = f.type === 'date' ? UI.thaiDate(r[f.key]) : cellVal(r[f.key]);
            var emptyReq = cellVal(r[f.key]).trim() === '';
            html += '<td class="small' + (blank ? ' rored' : '') + '" style="' + w + '"' +
              (emptyReq ? ' title="ยังไม่มีระเบียนต้นทาง (ยังไม่มีการมา ANC/ดูแลหลังคลอด) จึงแก้ที่นี่ไม่ได้"' : '') + '>' +
              esc(disp || '-') + '</td>';
          }
        });
        html += '</tr>';
      });
      html += '</tbody></table></div>';
      if (d.grandTotal > rows.length) {
        html += '<div class="card-pad tiny muted t-center">⚡ แสดง ' + UI.num(rows.length) + ' จาก ' + UI.num(d.grandTotal) + ' รายการ — แคบช่วงวันที่หรือค้นหาเพื่อดูครบ</div>';
      }
    }
    html += '</div>';
    root.innerHTML = html;

    $$('#pageAnc button.aseg').forEach(function (b) {
      b.addEventListener('click', function () { state.ancMode = b.dataset.mode; refresh(); });
    });
    bindAncCells();
  }

  function bindAncCells() {
    $$('#pageAnc input.acin').forEach(function (inp) {
      inp.dataset.orig = inp.value;
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        else if (e.key === 'Escape') { inp.value = inp.dataset.orig; inp.blur(); }
      });
      inp.addEventListener('blur', function () { commitAncField(inp); });
    });
  }

  async function commitAncField(inp) {
    var v = inp.value.trim();
    if (v === inp.dataset.orig) return;              // ไม่เปลี่ยน
    if (v === '') { inp.value = inp.dataset.orig; return; }  // ว่าง = ไม่บันทึก
    var td = inp.closest('td');
    var ctx = {
      ancId: inp.dataset.anc || undefined, personId: inp.dataset.person || undefined,
      svcId: inp.dataset.svc || undefined, careId: inp.dataset.care || undefined,
      vn: inp.dataset.vn || undefined, hn: inp.dataset.hn || undefined
    };
    td.classList.add('saving');
    try {
      var r = await API.call('save.ancfield', { mode: state.ancMode, field: inp.dataset.field, ctx: ctx, value: v });
      inp.value = (r.value === null || r.value === undefined) ? v : String(r.value);
      inp.dataset.orig = inp.value;
      td.classList.remove('saving', 'blank', 'err');
      td.classList.add('saved');
      setTimeout(function () { td.classList.remove('saved'); }, 1400);
    } catch (e) {
      td.classList.remove('saving');
      td.classList.add('err');
      inp.value = inp.dataset.orig;
      if (!guardExpiry(e)) UI.toast('บันทึกไม่สำเร็จ', e.message, 'err', 5000);
    }
  }

  /* ================= หน้าผู้ป่วยใน (ipt / iptdiag / iptoprt / opitemrece) ================= */
  var IPD_BASIS = [
    { key: 'stay', label: '🛏️ ยังไม่จำหน่าย (นอนอยู่)' },
    { key: 'dch',  label: '🏠 จำหน่ายในช่วงวันที่' },
    { key: 'adm',  label: '📥 Admit ในช่วงวันที่' }
  ];
  var IPD_DETAIL_TITLE = {
    dx: 'การวินิจฉัย (DIAGNOSIS_IPD)',
    proc: 'หัตถการ (PROCEDURE_IPD)',
    drug: 'ยา (DRUG_IPD) — ดูอย่างเดียว',
    charge: 'ค่าใช้จ่าย (CHARGE_IPD) — ดูอย่างเดียว',
    vs: 'Vital sign — ดูอย่างเดียว',
    advice: '💡 คำแนะนำการลงข้อมูลเพื่อ DRG'
  };
  var DIAG_TYPES = [
    ['1', '1 Principal'], ['2', '2 Comorbidity'], ['3', '3 Complication'], ['4', '4 Other'],
    ['5', '5 External cause'], ['6', '6 Additional'], ['7', '7 Morphology']
  ];

  function money(v) {
    return (Number(v) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function ipdRowOf(an) {
    var rows = (state.ipdData && state.ipdData.rows) || [];
    return rows.filter(function (r) { return String(r.an) === String(an); })[0] || null;
  }

  // โหมด "ยังไม่จำหน่าย" ไม่ต้องแสดงคอลัมน์สถานะ/วิธีจำหน่าย
  var IPD_DCH_KEYS = { dchstts: 1, dchtype: 1 };
  function ipdVisibleFields(d) {
    var basis = d.basis || state.ipdBasis;
    return (d.fields || []).filter(function (f) { return basis !== 'stay' || !IPD_DCH_KEYS[f.key]; });
  }

  function renderIpd(root, d) {
    state.ipdData = d;
    var fields = ipdVisibleFields(d);
    var rows = (d.rows || []).slice(0, RENDER_CAP);
    var ss = d.summary || { total: 0, complete: 0, incomplete: 0, percent: 0, fields: [] };
    var basis = d.basis || state.ipdBasis;

    var html = '<div class="stats">' +
      stat(basis === 'stay' ? 'ผู้ป่วยที่นอนอยู่' : 'ผู้ป่วยใน', UI.num(ss.total), basis === 'stay' ? 'ยังไม่จำหน่าย' : 'ตามช่วงวันที่ที่เลือก', '🛏️', '') +
      stat('ยังไม่ครบถ้วน', UI.num(ss.incomplete), 'มีช่องสีแดงต้องลง', '⚠️', 'peach') +
      stat('ครบถ้วนแล้ว', UI.num(ss.complete), 'ครบทุกช่องที่ต้องลง', '✅', 'mint') +
      stat('ความสมบูรณ์เฉลี่ย', ss.percent + '%', 'คิดเฉพาะช่องที่ต้องลงของแต่ละราย', '💜', 'sky') +
      '</div>';

    // แถบเลือกมุมมอง + ward
    var seg = IPD_BASIS.map(function (b) {
      return '<button class="btn btn-sm ' + (b.key === basis ? 'btn-primary' : 'btn-soft') + ' ibasis" data-basis="' + b.key + '">' + esc(b.label) + '</button>';
    }).join('');
    var wards = d.wards || [];
    var wTotal = wards.reduce(function (a, w) { return a + w.count; }, 0);
    var hasSel = !state.ipdWard || wards.some(function (w) { return w.ward === state.ipdWard; });
    var wopt = '<option value="">— ทุก ward (' + UI.num(wTotal) + ') —</option>' +
      (hasSel ? '' : '<option value="' + esc(state.ipdWard) + '" selected>Ward ' + esc(state.ipdWard) + ' (0)</option>') +
      wards.map(function (w) {
        return '<option value="' + esc(w.ward) + '"' + (w.ward === state.ipdWard ? ' selected' : '') + '>' +
          esc(w.name) + ' (' + UI.num(w.count) + ')</option>';
      }).join('');

    html += '<div class="card">' +
      '<div class="ipd-bar">' +
      '<select class="select" id="ipdWard" title="เลือก ward">' + wopt + '</select>' + seg +
      '<span class="small muted">' + (basis === 'stay' ? 'มุมมองนี้ไม่ใช้ช่วงวันที่ — แสดงทุกคนที่ยังไม่จำหน่าย'
        : 'ใช้ช่วงวันที่ด้านบน (' + esc(UI.thaiDate(d.from)) + ' – ' + esc(UI.thaiDate(d.to)) + ')') + '</span></div>';

    // ช่องที่ขาด (กดเพื่อกรอง)
    var visKeys = {};
    fields.forEach(function (f) { visKeys[f.key] = 1; });
    var missList = (ss.fields || []).filter(function (f) { return visKeys[f.key]; });
    if (missList.length || ss.advice) {
      html += '<div class="ipd-miss"><span class="small bold" style="align-self:center">ช่องที่ยังไม่ได้ลง:</span>' +
        missList.map(function (f) {
          return '<span class="chip imiss' + (state.ipdMiss === f.key ? ' on' : '') + '" data-key="' + f.key + '" title="' + esc(f.file + (f.hint ? ' — ' + f.hint : '')) + '">' +
            esc(f.label) + ' · ' + UI.num(f.missing) + '</span>';
        }).join('') +
        (ss.advice ? '<span class="chip adv imiss' + (state.ipdMiss === 'advice' ? ' on' : '') + '" data-key="advice" title="รายที่มีคำแนะนำให้ลงเพิ่ม/เรียงลำดับ ICD เพื่อ DRG">💡 มีคำแนะนำ DRG · ' + UI.num(ss.advice) + '</span>' : '') +
        (state.ipdMiss ? '<span class="chip ok imiss" data-key="">✕ ล้างตัวกรอง</span>' : '') + '</div>';
    }

    if (!rows.length) {
      html += '<div class="card-pad"><div class="empty"><div class="ico">🛏️</div>ไม่พบผู้ป่วยในตามเงื่อนไขที่เลือก' +
        '<div class="small mt-8">ลองเปลี่ยน ward มุมมอง หรือสถานะข้อมูล</div></div></div>';
    } else {
      // หัวตาราง 2 แถว: กลุ่มแฟ้ม / ชื่อช่อง
      var groups = [];
      fields.forEach(function (f) {
        var g = groups[groups.length - 1];
        if (g && g.file === f.file) g.n++; else groups.push({ file: f.file, n: 1 });
      });
      html += '<div class="table-wrap gridscroll" style="max-height:calc(100vh - 320px);overflow:auto">' +
        '<table class="tbl grid"><thead><tr>' +
        '<th class="nowrap" rowspan="2">%</th><th class="nowrap" rowspan="2">AN</th><th class="nowrap" rowspan="2">HN</th>' +
        '<th class="nowrap" rowspan="2">ชื่อผู้ป่วย</th><th class="nowrap" rowspan="2">กองทุน</th>' +
        '<th class="nowrap" rowspan="2">Admit</th><th class="nowrap" rowspan="2">จำหน่าย</th><th class="nowrap" rowspan="2">วันนอน</th>' +
        groups.map(function (g) { return '<th class="fgrp" colspan="' + g.n + '">' + esc(g.file) + '</th>'; }).join('') +
        '</tr><tr>' +
        fields.map(function (f) { return '<th class="nowrap edit-h">' + esc(f.label) + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
        rows.map(function (r) { return ipdRowHtml(r, fields); }).join('') +
        '</tbody></table></div>';
    }
    html += '</div>';
    root.innerHTML = html;

    $$('#pageIpd .ibasis').forEach(function (b) {
      b.addEventListener('click', function () { state.ipdBasis = b.dataset.basis; state.ipdMiss = ''; refresh(); });
    });
    $('#ipdWard').addEventListener('change', function () { state.ipdWard = this.value; state.ipdMiss = ''; refresh(); });
    $$('#pageIpd .imiss').forEach(function (c) {
      c.addEventListener('click', function () { state.ipdMiss = (state.ipdMiss === c.dataset.key) ? '' : c.dataset.key; refresh(); });
    });
    bindIpdCells($('#pageIpd'));
  }

  function ipdRowHtml(r, fields) {
    var ctx = r._ctx || {};
    var html = '<tr data-an="' + esc(r.an) + '">';
    html += '<td class="t-center nowrap"><span class="pcbadge ' + UI.tone(r._percent) + '">' + r._percent + '%</span></td>';
    html += '<td class="t-mono">' + esc(cellVal(r.an)) + '</td>';
    html += '<td class="t-mono">' + esc(cellVal(r.hn) || '-') + '</td>';
    html += '<td class="nowrap">' + esc(cellVal(r.ptname).trim() || '-') + '</td>';
    html += '<td class="t-center"><span class="badge badge-violet small">' + esc(r.hipdata_code || '-') + '</span></td>';
    html += '<td class="nowrap small">' + esc(UI.thaiDate(r.regdate) || '-') + ' ' + esc(r.regtime || '') + '</td>';
    html += '<td class="nowrap small">' + (r._discharged ? esc(UI.thaiDate(r.dchdate)) + ' ' + esc(r.dchtime || '')
      : '<span class="badge badge-mint small">นอนอยู่</span>') + '</td>';
    html += '<td class="t-center small">' + (r._los === null ? '-' : esc(String(r._los))) + '</td>';

    fields.forEach(function (f) {
      var req = (r._req || []).indexOf(f.key) >= 0;
      var miss = (r._missing || []).indexOf(f.key) >= 0;
      var w = 'min-width:' + (f.w || 100) + 'px';
      var tip = miss && f.hint ? ' title="' + esc(f.hint) + '"' : (!req ? ' title="รายนี้ไม่ต้องลงช่องนี้"' : '');
      var sub = f.name && cellVal(r[f.name]) ? '<div class="cin-sub">' + esc(r[f.name]) + '</div>' : '';
      if (f.key === 'pdx' && sub) sub = '<div class="pdxname" title="' + esc(r[f.name]) + '">' + esc(r[f.name]) + '</div>';

      if (f.key === 'advice_n') {
        var an_ = Number(r.advice_n) || 0;
        html += '<td class="nowrap advcell' + (an_ ? '' : ' none') + '" style="' + w + '" title="' + esc(f.hint) + '">' +
          '<button class="cntbtn idet" data-an="' + esc(r.an) + '" data-kind="advice">' +
          (an_ ? '💡 ' + UI.num(an_) + ' ข้อ' : '✓ ไม่มี') + ' 🔍</button></td>';
        return;
      }

      if (f.detail && (f.type === 'count' || f.key === 'pdx')) {
        var label;
        if (f.key === 'pdx') label = cellVal(r.pdx) || '+ เพิ่ม';
        else if (f.key === 'charge_n') label = UI.num(r.charge_n) + ' รายการ | ' + money(r.charge_sum) + ' บาท';
        else if (f.key === 'vs_n') label = UI.num(r.vs_n || 0) + ' / ต้อง ' + UI.num(r._vs_need || 0) + ' ครั้ง';
        else label = UI.num(r[f.key] || 0) + ' รายการ';
        html += '<td class="nowrap' + (miss ? ' rored' : (!req ? ' nreq' : '')) + '" style="' + w + '"' + tip + '>' +
          '<button class="cntbtn idet" data-an="' + esc(r.an) + '" data-kind="' + f.detail + '">' +
          // ค่าใช้จ่าย: แยก "จำนวนรายการ" กับ "ยอดบาท" เป็น 2 บรรทัด กันอ่านเลขติดกันผิด
          (label.indexOf(' | ') >= 0
            ? '<span style="display:flex;flex-direction:column;align-items:flex-start;line-height:1.35"><span>' +
              esc(label).replace(' | ', '</span><span style="color:var(--ink)">') + '</span></span>'
            : esc(label)) + ' 🔍</button>' +
          (f.key === 'pdx' ? sub : '') + '</td>';
        return;
      }
      var canEdit = f.editable && cellVal(ctx[f.keyReq]).trim() !== '';
      if (canEdit) {
        var t = (f.type === 'int' || f.type === 'float') ? 'number' : 'text';
        html += '<td class="editcell' + (miss ? ' blank' : '') + (!req ? ' nreq' : '') + '" style="' + w + '"' + tip + '>' +
          '<input class="cin icin" type="' + t + '"' + (t === 'number' ? ' step="any"' : '') +
          ' data-field="' + f.key + '" data-an="' + esc(r.an) + '" value="' + esc(cellVal(r[f.key])) + '">' + sub + '</td>';
        return;
      }
      var disp = f.key === 'drg' ? (cellVal(r.drg) ? r.drg + ' / ' + (r.adjrw || 0) : '') : cellVal(r[f.key]);
      html += '<td class="small' + (miss ? ' rored' : (!req ? ' nreq' : '')) + '" style="' + w + '"' + tip + '>' +
        esc(disp || '-') + sub + '</td>';
    });
    return html + '</tr>';
  }

  function bindIpdCells(scope) {
    $$('input.icin', scope).forEach(function (inp) {
      inp.dataset.orig = inp.value;
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        else if (e.key === 'Escape') { inp.value = inp.dataset.orig; inp.blur(); }
      });
      inp.addEventListener('blur', function () { commitIpdField(inp); });
    });
    $$('button.idet', scope).forEach(function (b) {
      b.addEventListener('click', function () { openIpdDetail(b.dataset.an, b.dataset.kind); });
    });
  }

  /** แทนแถวในตารางด้วยข้อมูลล่าสุดจาก server (ช่องที่ต้องลงอาจเปลี่ยนตามค่าที่เพิ่งบันทึก) */
  function updateIpdRow(row, flashField) {
    if (!row || !state.ipdData) return;
    var rows = state.ipdData.rows || [];
    for (var i = 0; i < rows.length; i++) if (String(rows[i].an) === String(row.an)) rows[i] = row;
    var tr = $('#pageIpd tr[data-an="' + row.an + '"]');
    if (!tr) return;
    var tmp = document.createElement('tbody');
    tmp.innerHTML = ipdRowHtml(row, ipdVisibleFields(state.ipdData));
    var nt = tmp.firstChild;
    tr.parentNode.replaceChild(nt, tr);
    bindIpdCells(nt);
    if (flashField) {
      var inp = nt.querySelector('input[data-field="' + flashField + '"]');
      var td = inp && inp.closest('td');
      if (td) { td.classList.add('saved'); setTimeout(function () { td.classList.remove('saved'); }, 1400); }
    }
  }

  async function commitIpdField(inp) {
    var v = inp.value.trim();
    if (v === inp.dataset.orig) return;
    if (v === '') { inp.value = inp.dataset.orig; return; }
    var row = ipdRowOf(inp.dataset.an);
    if (!row) return;
    var td = inp.closest('td');
    td.classList.add('saving');
    try {
      var r = await API.call('save.ipdfield', { field: inp.dataset.field, ctx: row._ctx, value: v });
      updateIpdRow(r.row, inp.dataset.field);
    } catch (e) {
      td.classList.remove('saving');
      td.classList.add('err');
      inp.value = inp.dataset.orig;
      if (!guardExpiry(e)) UI.toast('บันทึกไม่สำเร็จ', e.message, 'err', 5000);
    }
  }

  /* ---- หน้าต่างรายละเอียด Dx / หัตถการ / ยา / ค่าใช้จ่าย ---- */
  async function openIpdDetail(an, kind) {
    var row = ipdRowOf(an) || { an: an };
    var root = $('#modalRoot');
    root.innerHTML = '<div class="modal-back" id="idBack"><div class="modal" style="max-width:' + (kind === 'proc' ? 1080 : kind === 'advice' ? 1000 : 900) + 'px">' +
      '<div class="modal-head"><div><h3 style="font-size:17px">' + esc(IPD_DETAIL_TITLE[kind] || '') + '</h3>' +
      '<div class="small muted">AN ' + esc(an) + ' · HN ' + esc(cellVal(row.hn)) + ' · ' + esc(cellVal(row.ptname)) +
      ' · Admit ' + esc(UI.thaiDate(row.regdate) || '-') + (row._discharged ? ' · จำหน่าย ' + esc(UI.thaiDate(row.dchdate)) : ' · ยังไม่จำหน่าย') + '</div></div>' +
      '<button class="x-btn" id="idClose">✕</button></div>' +
      '<div class="modal-body" id="idBody"><div class="empty"><span class="spin dark" style="width:26px;height:26px;border-width:3px"></span></div></div>' +
      '<datalist id="ipdIcd10DL"></datalist><datalist id="ipdIcd9DL"></datalist><datalist id="ipdDocDL"></datalist>' +
      '</div></div>';
    var close = function () { root.innerHTML = ''; };
    $('#idClose').addEventListener('click', close);
    $('#idBack').addEventListener('click', function (e) { if (e.target.id === 'idBack') close(); });
    try {
      var r = await API.call('data.ipddetail', { an: an, kind: kind });
      if (kind === 'advice' && r.items && r.items.row) updateIpdRow(r.items.row);
      drawIpdDetail(an, kind, r.items || []);
    } catch (e) {
      if (guardExpiry(e)) return;
      $('#idBody').innerHTML = errCard(e.message);
    }
  }

  /** datalist ที่ค้นจาก server ระหว่างพิมพ์ (ICD10 / ICD9 / แพทย์) */
  function liveList(inp, listId, endpoint) {
    var t = null;
    inp.addEventListener('input', function () {
      clearTimeout(t);
      var q = inp.value.trim();
      if (q.length < 1) return;
      t = setTimeout(async function () {
        try {
          var r = await API.call(endpoint, { q: q });
          var dl = document.getElementById(listId);
          if (dl) dl.innerHTML = (r.items || []).map(function (x) {
            return '<option value="' + esc(x.code) + '">' + esc(x.code + ' ' + (x.name || '')) + '</option>';
          }).join('');
        } catch (e) { /* เงียบ */ }
      }, 250);
    });
  }

  async function ipdMutate(an, kind, endpoint, payload, btn) {
    if (btn) UI.busy(btn, true, '…');
    try {
      var r = await API.call(endpoint, Object.assign({ an: an }, payload));
      drawIpdDetail(an, kind, r.items || []);
      updateIpdRow(r.row);
      UI.toast('บันทึกแล้ว', '', 'ok', 1800);
    } catch (e) {
      if (btn) UI.busy(btn, false);
      if (!guardExpiry(e)) UI.toast('บันทึกไม่สำเร็จ', e.message, 'err', 6000);
    }
  }

  function drawIpdDetail(an, kind, items) {
    var row = ipdRowOf(an) || {};
    var body = $('#idBody');
    if (!body) return;
    var html = '';
    var docInp = function (cls, val, extra) {
      return '<input class="input ' + cls + '" list="ipdDocDL" placeholder="รหัสแพทย์" style="width:110px" value="' + esc(cellVal(val)) + '"' + (extra || '') + '>';
    };

    if (kind === 'dx') {
      var hasPdx = items.some(function (x) { return String(x.diagtype) === '1'; });
      html += '<div class="table-wrap"><table class="tbl mtbl"><thead><tr><th>ประเภท</th><th>ICD10</th><th>ชื่อโรค</th><th>แพทย์</th><th></th></tr></thead><tbody>' +
        (items.length ? items.map(function (x) {
          var noDoc = !cellVal(x.doctor).trim();
          return '<tr data-id="' + esc(x.id) + '"><td><select class="select dxtype">' + DIAG_TYPES.map(function (t) {
              return '<option value="' + t[0] + '"' + (String(x.diagtype) === t[0] ? ' selected' : '') + '>' + esc(t[1]) + '</option>';
            }).join('') + '</select></td>' +
            '<td class="t-mono bold">' + esc(x.icd10) + '</td><td class="small">' + esc(x.icd_name || '') + '</td>' +
            '<td class="' + (noDoc ? 'rored' : '') + '">' + docInp('dxdoc', x.doctor) + ' <span class="tiny muted">' + esc(x.doctor_name || '') + '</span></td>' +
            '<td><button class="btn btn-sm btn-ghost dxdel">🗑️</button></td></tr>';
        }).join('') : '<tr><td colspan="5" class="t-center muted">ยังไม่มีการวินิจฉัย</td></tr>') +
        '</tbody></table></div>';
      html += '<div class="ipd-form">' +
        '<div class="fg"><label>ICD10</label><input class="input" id="nDx" list="ipdIcd10DL" placeholder="พิมพ์รหัส/ชื่อโรค" style="width:180px"></div>' +
        '<div class="fg"><label>ประเภท</label><select class="select" id="nDxType">' + DIAG_TYPES.map(function (t) {
          return '<option value="' + t[0] + '"' + (t[0] === (hasPdx ? '2' : '1') ? ' selected' : '') + '>' + esc(t[1]) + '</option>';
        }).join('') + '</select></div>' +
        '<div class="fg"><label>แพทย์</label>' + docInp('', row.owner_doctor, ' id="nDxDoc"') + '</div>' +
        '<button class="btn btn-primary btn-sm" id="nDxAdd">＋ เพิ่มการวินิจฉัย</button></div>';
      if (!hasPdx) html += '<div class="small mt-8" style="color:#b00d1c">⚠️ ยังไม่มี Pdx (ประเภท 1)</div>';
    } else if (kind === 'proc') {
      html += '<div class="table-wrap"><table class="tbl mtbl"><thead><tr><th>วันที่เริ่ม</th><th>เวลา</th><th>วันที่สิ้นสุด</th><th>เวลา</th>' +
        '<th>ICD9</th><th>ชื่อหัตถการ</th><th>แพทย์/ผู้ทำ</th><th></th></tr></thead><tbody>' +
        (items.length ? items.map(function (x) {
          var red = function (v) { return cellVal(v).trim() ? '' : ' rored'; };
          return '<tr data-id="' + esc(x.id) + '">' +
            '<td class="' + red(x.opdate) + '"><input class="input pf" data-k="opdate" type="date" value="' + esc(cellVal(x.opdate)) + '"></td>' +
            '<td><input class="input pf" data-k="optime" type="time" value="' + esc(cellVal(x.optime)) + '"></td>' +
            '<td><input class="input pf" data-k="enddate" type="date" value="' + esc(cellVal(x.enddate)) + '"></td>' +
            '<td><input class="input pf" data-k="endtime" type="time" value="' + esc(cellVal(x.endtime)) + '"></td>' +
            '<td class="' + red(x.icd9) + '"><input class="input pf" data-k="icd9" list="ipdIcd9DL" style="width:90px" value="' + esc(cellVal(x.icd9)) + '"></td>' +
            '<td class="small">' + esc(x.icd9_name || '') + '</td>' +
            '<td class="' + red(x.doctor) + '">' + docInp('pf', x.doctor, ' data-k="doctor"') + ' <span class="tiny muted">' + esc(x.doctor_name || '') + '</span></td>' +
            '<td><button class="btn btn-sm btn-ghost pdel">🗑️</button></td></tr>';
        }).join('') : '<tr><td colspan="8" class="t-center muted">ยังไม่มีหัตถการ</td></tr>') +
        '</tbody></table></div>';
      html += '<div class="ipd-form">' +
        '<div class="fg"><label>ICD9</label><input class="input" id="nPx" list="ipdIcd9DL" placeholder="พิมพ์รหัส/ชื่อ" style="width:160px"></div>' +
        '<div class="fg"><label>วันที่ทำ</label><input class="input" id="nPxDate" type="date" value="' + esc(cellVal(row.regdate)) + '"></div>' +
        '<div class="fg"><label>เวลาเริ่ม</label><input class="input" id="nPxTime" type="time"></div>' +
        '<div class="fg"><label>เวลาเสร็จ</label><input class="input" id="nPxEnd" type="time"></div>' +
        '<div class="fg"><label>แพทย์/ผู้ทำ</label>' + docInp('', row.owner_doctor, ' id="nPxDoc"') + '</div>' +
        '<button class="btn btn-primary btn-sm" id="nPxAdd">＋ เพิ่มหัตถการ</button></div>';
    } else if (kind === 'advice') {
      html += ipdAdviceHtml(row, items || {});
    } else if (kind === 'drug') {
      var tot = 0;
      html += '<div class="table-wrap" style="max-height:60vh;overflow:auto"><table class="tbl mtbl"><thead><tr><th>วันที่</th><th>รายการยา</th><th>ความแรง</th>' +
        '<th class="t-right">จำนวน</th><th>หน่วย</th><th class="t-right">ราคา/หน่วย</th><th class="t-right">รวม</th></tr></thead><tbody>' +
        (items.length ? items.map(function (x) {
          tot += Number(x.sum_price) || 0;
          return '<tr><td class="nowrap small">' + esc(UI.thaiDate(x.rxdate) || '-') + '</td><td>' + esc(x.name || x.icode) + '</td>' +
            '<td class="small">' + esc(x.strength || '') + '</td><td class="t-right">' + esc(UI.num(Number(x.qty) || 0)) + '</td>' +
            '<td class="small">' + esc(x.units || '') + '</td><td class="t-right">' + money(x.unitprice) + '</td><td class="t-right">' + money(x.sum_price) + '</td></tr>';
        }).join('') : '<tr><td colspan="7" class="t-center muted">ไม่มีรายการยา</td></tr>') +
        '</tbody></table></div><div class="t-right bold mt-8">รวม ' + money(tot) + ' บาท</div>';
    } else if (kind === 'vs') {
      // สรุปรายวัน: วันไหนลงน้อยกว่า 3 ครั้งเป็นสีแดง
      var perDay = {};
      items.forEach(function (x) { perDay[x.date] = (perDay[x.date] || 0) + 1; });
      var days = [];
      if (row.regdate) {
        var end = row.dchdate || UI.todayStr();
        for (var dd = new Date(row.regdate + 'T00:00:00'); dd <= new Date(end + 'T00:00:00') && days.length < 400; dd.setDate(dd.getDate() + 1)) {
          days.push(dd.getFullYear() + '-' + ('0' + (dd.getMonth() + 1)).slice(-2) + '-' + ('0' + dd.getDate()).slice(-2));
        }
      }
      html += '<div class="mb-8"><span class="bold">ลงแล้ว ' + UI.num(items.length) + ' ครั้ง</span> · วันนอน ' + UI.num(row._los || 0) +
        ' วัน · ต้องลงอย่างน้อย ' + UI.num(row._vs_need || 0) + ' ครั้ง (วันนอน × 3)</div>';
      if (days.length) {
        html += '<div class="ipd-miss" style="padding:0 0 10px;border:0">' + days.map(function (dy) {
          var c = perDay[dy] || 0;
          return '<span class="chip' + (c >= 3 ? ' ok' : '') + '">' + esc(UI.thaiDate(dy)) + ' · ' + c + ' ครั้ง</span>';
        }).join('') + '</div>';
      }
      html += '<div class="table-wrap" style="max-height:55vh;overflow:auto"><table class="tbl mtbl"><thead><tr><th>วันที่</th><th>เวลา</th>' +
        '<th class="t-right">T (°C)</th><th class="t-right">PR</th><th class="t-right">RR</th><th class="t-right">BP</th><th class="t-right">SpO2</th>' +
        '<th>ผู้บันทึก</th><th>แหล่งข้อมูล</th></tr></thead><tbody>' +
        (items.length ? items.map(function (x) {
          var bp = cellVal(x.sbp) || cellVal(x.dbp) ? cellVal(x.sbp) + '/' + cellVal(x.dbp) : '';
          return '<tr><td class="nowrap small">' + esc(UI.thaiDate(x.date) || '-') + '</td><td class="small">' + esc(x.time || '') + '</td>' +
            '<td class="t-right">' + esc(cellVal(x.temperature)) + '</td><td class="t-right">' + esc(cellVal(x.pulse)) + '</td>' +
            '<td class="t-right">' + esc(cellVal(x.rr)) + '</td><td class="t-right">' + esc(bp) + '</td><td class="t-right">' + esc(cellVal(x.spo2)) + '</td>' +
            '<td class="small">' + esc(cellVal(x.staff)) + '</td><td class="tiny muted">' + esc(x.src || '') + '</td></tr>';
        }).join('') : '<tr><td colspan="9" class="t-center muted">ยังไม่มีการลง vital sign</td></tr>') +
        '</tbody></table></div>';
    } else {
      var gt = 0;
      html += '<div class="table-wrap"><table class="tbl mtbl"><thead><tr><th>หมวดค่าใช้จ่าย</th><th class="t-right">รายการ</th>' +
        '<th class="t-right">จำนวน</th><th class="t-right">รวม (บาท)</th></tr></thead><tbody>' +
        (items.length ? items.map(function (x) {
          gt += Number(x.sum_price) || 0;
          return '<tr><td>' + esc(x.income_name || x.income || '-') + '</td><td class="t-right">' + esc(UI.num(Number(x.items) || 0)) + '</td>' +
            '<td class="t-right">' + esc(UI.num(Number(x.qty) || 0)) + '</td><td class="t-right">' + money(x.sum_price) + '</td></tr>';
        }).join('') : '<tr><td colspan="4" class="t-center muted">ไม่มีรายการค่าใช้จ่าย</td></tr>') +
        '</tbody></table></div><div class="t-right bold mt-8">รวมทั้งสิ้น ' + money(gt) + ' บาท</div>';
    }
    body.innerHTML = html;

    $$('#idBody input[list="ipdDocDL"]').forEach(function (i) { liveList(i, 'ipdDocDL', 'data.doctors'); });
    if (kind === 'advice') {
      bindIpdAdvice(an, items || {});
    } else if (kind === 'dx') {
      liveList($('#nDx'), 'ipdIcd10DL', 'data.icd10');
      $$('#idBody tr[data-id]').forEach(function (tr) {
        var id = tr.dataset.id;
        tr.querySelector('.dxtype').addEventListener('change', function () {
          ipdMutate(an, kind, 'ipd.diagupdate', { id: id, data: { diagtype: this.value } });
        });
        var di = tr.querySelector('.dxdoc');
        di.dataset.orig = di.value;
        di.addEventListener('change', function () {
          if (di.value.trim() && di.value !== di.dataset.orig) ipdMutate(an, kind, 'ipd.diagupdate', { id: id, data: { doctor: di.value.trim() } });
        });
        tr.querySelector('.dxdel').addEventListener('click', function () {
          if (window.confirm('ลบการวินิจฉัยนี้?')) ipdMutate(an, kind, 'ipd.diagdelete', { id: id }, this);
        });
      });
      $('#nDxAdd').addEventListener('click', function () {
        ipdMutate(an, kind, 'ipd.diagadd', { icd10: $('#nDx').value.trim(), diagtype: $('#nDxType').value, doctor: $('#nDxDoc').value.trim() }, this);
      });
    } else if (kind === 'proc') {
      liveList($('#nPx'), 'ipdIcd9DL', 'data.icd9');
      $$('#idBody tr[data-id]').forEach(function (tr) {
        var id = tr.dataset.id;
        $$('.pf', tr).forEach(function (inp) {
          inp.dataset.orig = inp.value;
          inp.addEventListener('change', function () {
            if (inp.value === inp.dataset.orig) return;
            var data = {}; data[inp.dataset.k] = inp.value.trim();
            ipdMutate(an, kind, 'ipd.procupdate', { id: id, data: data });
          });
        });
        tr.querySelector('.pdel').addEventListener('click', function () {
          if (window.confirm('ลบหัตถการนี้?')) ipdMutate(an, kind, 'ipd.procdelete', { id: id }, this);
        });
      });
      $('#nPxAdd').addEventListener('click', function () {
        ipdMutate(an, kind, 'ipd.procadd', { data: {
          icd9: $('#nPx').value.trim(), opdate: $('#nPxDate').value, optime: $('#nPxTime').value,
          enddate: $('#nPxDate').value, endtime: $('#nPxEnd').value, doctor: $('#nPxDoc').value.trim()
        } }, this);
      });
    }
  }

  /* ---- คำแนะนำ DRG: ลงเพิ่ม / เรียงลำดับ ICD10-ICD9 / ตรวจทาน ---- */
  function fmtIcd10(c) { return cellVal(c).toUpperCase().replace(/\./g, ''); }   // ICD10 ไม่มีจุด
  function fmtIcd9(c) { c = cellVal(c).replace(/\./g, ''); return c.length > 2 ? c.slice(0, 2) + '.' + c.slice(2) : c; }
  var ADV_SECTIONS = [
    { kind: 'order', title: '🔀 เรียงลำดับ / ประเภทการวินิจฉัย', sub: 'มีผลต่อการจัดกลุ่ม DRG โดยตรง' },
    { kind: 'add', title: '➕ ควรลงเพิ่ม', sub: 'มีหลักฐานจากยา / lab / ค่าใช้จ่าย แต่ยังไม่มีรหัส' },
    { kind: 'check', title: '🔍 ตรวจทาน', sub: 'อาจลงซ้ำ ไม่เจาะจง หรือไม่มี Dx รองรับ' }
  ];
  function diagTypeName(t) {
    var x = DIAG_TYPES.filter(function (d) { return d[0] === String(t); })[0];
    return x ? x[1] : (t || '-');
  }

  function ipdAdviceHtml(row, d) {
    var list = d.advice || [];
    var html = '<div class="adv-note">⚠️ คำแนะนำประเมินจากยา ผล lab และค่าใช้จ่ายที่บันทึกไว้ — <b>ลงรหัสเฉพาะที่แพทย์บันทึกไว้ในเวชระเบียน</b> ' +
      'การลงรหัสที่ไม่มีหลักฐานรองรับจะถูกเรียกเงินคืนเมื่อ audit' +
      (cellVal(row.owner_doctor) ? '' : '<br>ยังไม่มีแพทย์เจ้าของไข้ — ปุ่ม "เพิ่ม" ต้องใช้รหัสแพทย์ กรุณาลงแพทย์เจ้าของไข้ก่อน') + '</div>';
    if (!list.length) html += '<div class="empty" style="padding:18px"><div class="ico">✅</div>ไม่มีคำแนะนำสำหรับรายนี้</div>';
    ADV_SECTIONS.forEach(function (sec) {
      var items = list.map(function (a, i) { return { a: a, i: i }; }).filter(function (x) { return x.a.kind === sec.kind; });
      if (!items.length) return;
      html += '<div class="adv-sec"><h4>' + esc(sec.title) + ' <span class="small muted" style="font-weight:400">· ' + esc(sec.sub) + '</span></h4>' +
        items.map(function (x) {
          var a = x.a;
          return '<div class="adv-item ' + a.kind + '"><div><span class="badge small ' + (a.area === 'proc' ? 'badge-sky' : a.area === 'data' ? 'badge-mint' : 'badge-violet') + '">' +
            (a.area === 'proc' ? 'ICD9' : a.area === 'data' ? 'ข้อมูล' : 'ICD10') + '</span> ' + esc(a.text) + '</div>' +
            (a.action ? '<button class="btn btn-sm btn-primary advact" data-i="' + x.i + '">' + esc(a.action.label || 'ทำตามคำแนะนำ') + '</button>' : '') +
            '</div>';
        }).join('') + '</div>';
    });

    // ลำดับที่แนะนำ
    var od = (d.order && d.order.dx) || [];
    var op = (d.order && d.order.proc) || [];
    if (od.length) {
      var diff = od.some(function (x) { return String(x.suggest_type) !== String(x.diagtype); });
      html += '<div class="adv-sec"><h4>📋 ลำดับ ICD10 ที่แนะนำ <span class="small muted" style="font-weight:400">· Pdx → โรคร่วม → โรคแทรกซ้อน → อื่น ๆ → สาเหตุภายนอก</span></h4>' +
        '<div class="table-wrap"><table class="tbl mtbl"><thead><tr><th>ลำดับ</th><th>ICD10</th><th>ชื่อโรค</th><th>ประเภทปัจจุบัน</th><th>ประเภทที่แนะนำ</th></tr></thead><tbody>' +
        od.map(function (x, i) {
          var ch = String(x.suggest_type) !== String(x.diagtype);
          return '<tr class="' + (ch ? 'adv-diff' : '') + '"><td class="t-center">' + (i + 1) + '</td><td class="t-mono bold">' + esc(fmtIcd10(x.icd10)) + '</td>' +
            '<td class="small">' + esc(x.icd_name || '') + '</td><td class="small">' + esc(diagTypeName(x.diagtype)) + '</td>' +
            '<td class="small' + (ch ? ' bold' : '') + '">' + esc(diagTypeName(x.suggest_type)) + (ch ? ' ←' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        (diff ? '<div class="mt-8"><button class="btn btn-sm btn-primary" id="advApplyOrder">ปรับประเภทตามที่แนะนำ</button></div>' : '') + '</div>';
    }
    if (op.length) {
      html += '<div class="adv-sec"><h4>📋 ลำดับ ICD9 ที่แนะนำ <span class="small muted" style="font-weight:400">· หัตถการหลัก/ผ่าตัด (01–86) ก่อน แล้วตามด้วยหัตถการรอง/วินิจฉัย (87–99) เรียงตามวันที่</span></h4>' +
        '<div class="table-wrap"><table class="tbl mtbl"><thead><tr><th>ลำดับ</th><th>ICD9</th><th>ชื่อหัตถการ</th><th>วันที่</th><th>ชนิด</th></tr></thead><tbody>' +
        op.map(function (x, i) {
          return '<tr><td class="t-center">' + (i + 1) + '</td><td class="t-mono bold">' + esc(fmtIcd9(x.icd9) || '-') + '</td><td class="small">' + esc(x.icd9_name || '') + '</td>' +
            '<td class="small nowrap">' + esc(UI.thaiDate(x.opdate) || '-') + '</td>' +
            '<td>' + (x.major ? '<span class="badge badge-violet small">หลัก/ผ่าตัด</span>' : '<span class="badge small">รอง</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="tiny muted mt-8">แฟ้ม PROCEDURE_IPD ไม่มีช่องลำดับ — ใช้ลำดับนี้เป็นแนวทางเวลาสรุปเวชระเบียน (Discharge summary) และตรวจว่าลงหัตถการหลักครบ</div></div>';
    }
    return html;
  }

  async function reloadIpdAdvice(an) {
    var r = await API.call('data.ipddetail', { an: an, kind: 'advice' });
    if (r.items && r.items.row) updateIpdRow(r.items.row);
    drawIpdDetail(an, 'advice', r.items || {});
  }

  async function runIpdAdvice(an, a, btn) {
    var row = ipdRowOf(an) || {};
    var act = a.action || {};
    var doc = cellVal(row.owner_doctor).trim();
    var msg;
    if (act.type === 'adddx') msg = 'ยืนยันว่าแพทย์บันทึกการวินิจฉัย ' + fmtIcd10(act.icd10) + ' ไว้ในเวชระเบียนแล้ว และต้องการเพิ่มเป็น ' + diagTypeName(act.diagtype) + '?';
    else if (act.type === 'addproc') msg = 'ยืนยันว่าทำหัตถการ ' + fmtIcd9(act.icd9) + ' จริง และต้องการเพิ่มวันที่ ' + (UI.thaiDate(act.opdate) || '-') + '?';
    else msg = 'ยืนยัน: ' + (act.label || 'ทำตามคำแนะนำ') + '?';
    if ((act.type === 'adddx' || act.type === 'addproc') && !doc) { UI.toast('ยังไม่มีแพทย์เจ้าของไข้', 'กรุณาลงแพทย์เจ้าของไข้ก่อน แล้วค่อยเพิ่มรหัส', 'err', 5000); return; }
    if (!window.confirm(msg)) return;
    UI.busy(btn, true, '…');
    try {
      if (act.type === 'adddx') await API.call('ipd.diagadd', { an: an, icd10: act.icd10, diagtype: act.diagtype || '2', doctor: doc });
      else if (act.type === 'addproc') await API.call('ipd.procadd', { an: an, data: { icd9: act.icd9, opdate: act.opdate, enddate: act.opdate, doctor: doc } });
      else if (act.type === 'settype') await API.call('ipd.diagupdate', { an: an, id: act.id, data: { diagtype: act.diagtype } });
      else if (act.type === 'swap') {
        await API.call('ipd.diagupdate', { an: an, id: act.oldId, data: { diagtype: act.oldType || '2' } });
        await API.call('ipd.diagupdate', { an: an, id: act.id, data: { diagtype: '1' } });
      }
      UI.toast('บันทึกแล้ว', act.label || '', 'ok', 1800);
      await reloadIpdAdvice(an);
    } catch (e) {
      UI.busy(btn, false);
      if (!guardExpiry(e)) UI.toast('บันทึกไม่สำเร็จ', e.message, 'err', 6000);
    }
  }

  function bindIpdAdvice(an, d) {
    $$('#idBody .advact').forEach(function (b) {
      b.addEventListener('click', function () { runIpdAdvice(an, (d.advice || [])[Number(b.dataset.i)] || {}, b); });
    });
    var ap = $('#advApplyOrder');
    if (ap) ap.addEventListener('click', async function () {
      var ch = ((d.order && d.order.dx) || []).filter(function (x) { return String(x.suggest_type) !== String(x.diagtype); });
      if (!ch.length || !window.confirm('ปรับประเภทการวินิจฉัย ' + ch.length + ' รายการตามที่แนะนำ?\n' +
        ch.map(function (x) { return fmtIcd10(x.icd10) + ': ' + diagTypeName(x.diagtype) + ' → ' + diagTypeName(x.suggest_type); }).join('\n'))) return;
      UI.busy(ap, true, '…');
      // เปลี่ยนรายการที่ออกจาก Pdx ก่อน แล้วค่อยตั้ง Pdx ใหม่
      ch.sort(function (a, b) { return (String(a.suggest_type) === '1') - (String(b.suggest_type) === '1'); });
      try {
        for (var i = 0; i < ch.length; i++) await API.call('ipd.diagupdate', { an: an, id: ch[i].id, data: { diagtype: String(ch[i].suggest_type) } });
        UI.toast('ปรับลำดับแล้ว', '', 'ok', 1800);
        await reloadIpdAdvice(an);
      } catch (e) {
        UI.busy(ap, false);
        if (!guardExpiry(e)) UI.toast('บันทึกไม่สำเร็จ', e.message, 'err', 6000);
      }
    });
  }

  /* ================= หน้างานกายภาพบำบัด (physic_*) ================= */
  var PHYSIO_VIEW = [
    { key: 'vstdate', label: 'วันที่บริการ', cls: 'nowrap small', fmt: function (v) { return UI.thaiDate(v); }, check: true },
    { key: 'hn', label: 'HN', cls: 't-mono' },
    { key: 'ptname', label: 'ชื่อผู้ป่วย', cls: 'nowrap' },
    { key: 'cid', label: 'เลขบัตร', cls: 't-mono small', check: true },
    { key: 'an', label: 'AN', cls: 't-mono small' }
  ];
  // คอลัมน์ชุด OPD (ผูกกับ vn, บันทึกผ่าน save.field เหมือนหน้า OPD)
  var PHYSIO_OPD_COLS = [
    { key: 'pdx', label: 'Pdx (ICD10)', type: 'icd10', w: 150 },
    { key: 'diagbtn', label: 'แก้ไข Diag', type: 'button', w: 110 },
    { key: 'cc', label: 'อาการสำคัญ (CC)', type: 'text', w: 170 },
    { key: 'bps', label: 'SBP', type: 'int', w: 92 },
    { key: 'bpd', label: 'DBP', type: 'int', w: 92 },
    { key: 'temperature', label: 'อุณหภูมิ', type: 'float', w: 104 },
    { key: 'bw', label: 'นน.', type: 'float', w: 98 },
    { key: 'height', label: 'ส่วนสูง', type: 'float', w: 104 },
    { key: 'bmi', label: 'BMI', type: 'float', w: 98 }
  ];
  function physioOpdBlank(c, r) {
    var v = r[c.key];
    if (c.type === 'int' || c.type === 'float') return v === null || v === undefined || String(v).trim() === '' || Number(v) === 0;
    return v === null || v === undefined || String(v).trim() === '';
  }

  function renderPhysio(root, d) {
    var fields = d.fields;
    state.physioFields = fields;
    state.physioData = d;
    var type = state.physioType || 'all';
    var isOpdRow = function (r) { return cellVal(r.vn).trim() !== ''; };

    var allRows = d.rows;
    var opdAll = allRows.filter(isOpdRow);
    var ipdAll = allRows.filter(function (r) { return !isOpdRow(r); });
    var subset = type === 'opd' ? opdAll : (type === 'ipd' ? ipdAll : allRows);

    // สรุปเฉพาะกลุ่มที่เลือก
    var fieldCount = (d.fields || []).filter(function (f) { return f.check; }).length || 1;
    var ss = { total: subset.length, complete: 0, incomplete: 0, percent: 0 };
    var scoreSum = 0;
    subset.forEach(function (r) { if (r._complete) ss.complete++; scoreSum += (r._percent || 0); });
    ss.incomplete = ss.total - ss.complete;
    ss.percent = ss.total ? Math.round(scoreSum / ss.total) : 0;

    var rows = subset.slice(0, 400);
    var showOpdCols = type !== 'ipd';   // มุมมอง IPD ไม่แสดงคอลัมน์ชุด OPD

    // ตรวจ REHAB code (43) ซ้ำภายใน 1 vn
    var dupCount = {};
    subset.forEach(function (r) {
      var vn = cellVal(r.vn).trim(), code = cellVal(r.rehabcode).trim();
      if (vn && code) { var k = vn + '|' + code; dupCount[k] = (dupCount[k] || 0) + 1; }
    });
    var dupVns = {}, dupGroups = 0;
    Object.keys(dupCount).forEach(function (k) { if (dupCount[k] > 1) { dupGroups++; dupVns[k.split('|')[0]] = true; } });
    var isDup = function (r) { var vn = cellVal(r.vn).trim(), code = cellVal(r.rehabcode).trim(); return vn && code && dupCount[vn + '|' + code] > 1; };

    // แถวที่ยังไม่มีวันที่สิ้นสุดการรักษา (และมีทะเบียน + วันที่เริ่ม) → ปรับ dch_date = วันที่เริ่มได้
    var canFinish = function (r) {
      return cellVal(r.register_id).trim() !== '' && cellVal(r.date_finish).trim() === '' && cellVal(r.date_start).trim() !== '';
    };
    var finishEligible = subset.filter(canFinish).length;

    var html = '';

    // ปุ่มสลับ ทั้งหมด / OPD / IPD (แสดงต่อท้ายหัวข้อการ์ด)
    var seg = function (v, label, count) {
      return '<button class="btn btn-sm ' + (type === v ? 'btn-primary' : 'btn-soft') + ' pseg" data-type="' + v + '">' +
        esc(label) + ' <span class="badge badge-gray small" style="margin-left:4px">' + UI.num(count) + '</span></button>';
    };

    html += '<div class="stats">' +
      stat('รายการฟื้นฟู' + (type === 'opd' ? ' (OPD)' : type === 'ipd' ? ' (IPD)' : ''), UI.num(ss.total), 'OPD ' + UI.num(opdAll.length) + ' · IPD ' + UI.num(ipdAll.length), '🧑‍⚕️', '') +
      stat('ยังไม่ครบถ้วน', UI.num(ss.incomplete), 'มีช่องสีแดงต้องเติม', '⚠️', 'peach') +
      stat('ครบถ้วนแล้ว', UI.num(ss.complete), 'ครบ ' + fieldCount + ' ช่องที่ตรวจ', '✅', 'mint') +
      stat('ความสมบูรณ์เฉลี่ย', ss.percent + '%', 'จาก ' + fieldCount + ' ช่องต่อราย', '💜', 'sky') +
      '</div>';

    html += '<div class="card">' +
      '<div class="card-head"><div class="card-title">🧑‍⚕️ งานกายภาพบำบัด / ฟื้นฟูสมรรถภาพ' +
      (subset.length > rows.length ? ' <span class="badge badge-violet small" style="margin-left:6px">แสดง ' + UI.num(rows.length) + ' / ' + UI.num(subset.length) + '</span>' : '') +
      '</div>' +
      seg('all', 'ทั้งหมด', allRows.length) + seg('opd', 'OPD', opdAll.length) + seg('ipd', 'IPD', ipdAll.length) +
      (dupGroups > 0 ? '<button class="btn btn-sm btn-primary" id="physioMergeBtn" title="รวม REHAB code (43) ที่ซ้ำภายใน VN เดียวกัน แล้วรวมจำนวนเข้าด้วยกัน">🔗 รวม REHAB code ซ้ำ (' + UI.num(dupGroups) + ')</button>' : '') +
      (finishEligible > 0 ? '<button class="btn btn-sm btn-orange" id="physioFinishOpen" title="ปรับวันที่สิ้นสุดการรักษา = วันที่เริ่มฟื้นฟู สำหรับรายที่ยังไม่มีวันที่สิ้นสุด">🗓️ ปรับวันที่สิ้นสุด (' + UI.num(finishEligible) + ')</button>' : '') +
      '<span class="badge badge-rose small">🟥 ช่องสีแดง = ยังว่าง · แก้ในช่องแล้วบันทึกทันที</span></div>';

    if (!rows.length) {
      html += '<div class="card-pad"><div class="empty"><div class="ico">🧑‍⚕️</div>' +
        'ไม่พบรายการงานกายภาพตามเงื่อนไขที่เลือก' +
        '<div class="small mt-8">ลองเปลี่ยนวันที่ จุดบริการ หรือสถานะข้อมูล</div></div></div>';
    } else {
      // มุมมอง OPD ไม่ต้องมีคอลัมน์ AN (ทุกแถวมี VN อยู่แล้ว)
      var viewCols = (type === 'opd') ? PHYSIO_VIEW.filter(function (c) { return c.key !== 'an'; }) : PHYSIO_VIEW;
      html += '<div class="table-wrap gridscroll" style="max-height:calc(100vh - 340px);overflow:auto">' +
        '<table class="tbl grid"><thead><tr><th class="nowrap">%</th>';
      viewCols.forEach(function (c) { html += '<th class="nowrap">' + esc(c.label) + '</th>'; });
      fields.forEach(function (f) { html += '<th class="nowrap edit-h">' + esc(f.label) + '</th>'; });
      if (showOpdCols) { PHYSIO_OPD_COLS.forEach(function (c) { html += '<th class="nowrap edit-h">' + esc(c.label) + '</th>'; }); }
      html += '<th class="nowrap">VN</th></tr></thead><tbody>';

      rows.forEach(function (r) {
        var hasVn = cellVal(r.vn).trim() !== '';
        html += '<tr data-key="' + esc(r.key) + '">';
        html += '<td class="t-center nowrap"><span class="pcbadge ' + UI.tone(r._percent) + '">' + r._percent + '%</span>' +
          (r.src === 'I' ? '<div class="tiny" style="color:#b45309">IPD</div>' : '') + '</td>';
        var dataAttrs = ' data-key="' + esc(r.key) + '" data-src="' + esc(r.src) + '" data-pid="' + esc(r.pid) + '"' +
          ' data-items="' + esc(cellVal(r.items_id)) + '" data-reg="' + esc(cellVal(r.register_id)) + '" data-hn="' + esc(cellVal(r.hn)) + '"';
        viewCols.forEach(function (c) {
          var raw = cellVal(r[c.key]);
          if (c.key === 'cid') {   // CID แก้ไขได้ → patient.cid
            var cblank = raw.trim() === '';
            html += '<td class="editcell' + (cblank ? ' blank' : '') + '" style="min-width:130px">' +
              '<input class="cin pcin" type="text" data-field="cid"' + dataAttrs + ' value="' + esc(raw) + '"></td>';
            return;
          }
          var val = c.fmt ? c.fmt(r[c.key]) : raw;
          var rored = (c.check && raw.trim() === '') ? ' rored' : '';
          html += '<td class="' + c.cls + rored + '"' + (rored ? ' title="ควรบันทึกแต่ยังว่าง"' : '') + '>' + esc(val || '-') + '</td>';
        });
        var rowDup = isDup(r);
        fields.forEach(function (f) {
          var blank = r._missing.indexOf(f.key) >= 0;
          var w = 'min-width:' + (f.w || 100) + 'px';
          var dupCell = (f.key === 'rehabcode' && rowDup);   // REHAB code ซ้ำใน VN นี้
          var dupCls = dupCell ? ' pcdup' : '';
          var dupTitle = dupCell ? ' title="REHAB code นี้ซ้ำใน VN เดียวกัน — กดปุ่ม \'รวม REHAB code ซ้ำ\' เพื่อรวมจำนวน"' : '';
          // มีคีย์ต้นทางครบไหม (จึงจะแก้ไขได้)
          var canEdit = f.editable && (!f.srcD || r.src === 'D');
          if (canEdit && f.key === 'rehabcode' && cellVal(r.items_id).trim() === '') canEdit = false;
          if (canEdit && (f.key === 'rehabplace' || f.key === 'date_start' || f.key === 'date_finish') && cellVal(r.register_id).trim() === '') canEdit = false;
          if (canEdit) {
            var t = f.type === 'date' ? 'date' : 'text';
            html += '<td class="editcell pcell' + (blank ? ' blank' : '') + dupCls + '"' + dupTitle + ' style="' + w + '">' +
              '<input class="cin pcin" type="' + t + '" data-field="' + f.key + '"' + dataAttrs + ' value="' + esc(cellVal(r[f.key])) + '"></td>';
          } else {
            var disp = (f.type === 'rodate' || f.type === 'date') ? UI.thaiDate(r[f.key]) : (f.key === 'provider' ? (cellVal(r.provider_name) || cellVal(r.provider)) : cellVal(r[f.key]));
            html += '<td class="small' + (blank ? ' rored' : '') + dupCls + '" style="' + w + '" title="' + (dupCell ? 'REHAB code นี้ซ้ำใน VN เดียวกัน' : (blank ? 'ยังไม่มีข้อมูลและแก้ที่นี่ไม่ได้ (ไม่มีคีย์ต้นทาง)' : '')) + '">' +
              esc(disp || '-') + '</td>';
          }
        });
        // คอลัมน์ชุด OPD (ผูก vn) — ซ่อนทั้งหมดในมุมมอง IPD
        if (showOpdCols) PHYSIO_OPD_COLS.forEach(function (c) {
          if (!hasVn) { html += '<td class="t-center muted small">-</td>'; return; }
          if (c.type === 'button') {
            html += '<td class="t-center" style="min-width:' + c.w + 'px">' +
              '<button class="btn btn-soft btn-sm pdiagbtn" data-vn="' + esc(r.vn) + '">✏️ แก้ไข Diag</button></td>';
            return;
          }
          var ob = physioOpdBlank(c, r);
          var t2 = (c.type === 'int' || c.type === 'float') ? 'number' : 'text';
          html += '<td class="editcell' + (ob ? ' blank' : '') + '" style="min-width:' + c.w + 'px">' +
            '<input class="cin popd" type="' + t2 + '" data-vn="' + esc(r.vn) + '" data-field="' + c.key + '" data-type="' + c.type + '"' +
            (c.key === 'pdx' ? ' list="icdOptionsP" autocomplete="off"' : '') +
            ' value="' + esc(cellVal(r[c.key])) + '"></td>';
        });
        html += '<td class="t-mono small">' + esc(r.vn || r.an || '-') + '</td></tr>';
      });
      html += '</tbody></table></div><datalist id="icdOptionsP"></datalist>';
      if (subset.length > rows.length) {
        html += '<div class="card-pad tiny muted t-center">⚡ แสดง ' + UI.num(rows.length) + ' จาก ' + UI.num(subset.length) + ' รายการ — เลือกจุดบริการ/แคบช่วงวันที่เพื่อดูครบ</div>';
      }
    }
    html += '</div>';
    root.innerHTML = html;
    // ปุ่มสลับ OPD/IPD
    $$('#pagePhysio button.pseg').forEach(function (b) {
      b.addEventListener('click', function () {
        state.physioType = b.dataset.type;
        renderPhysio(root, state.physioData);
      });
    });
    var mbtn = $('#physioMergeBtn');
    if (mbtn) mbtn.addEventListener('click', openPhysioMergeModal);
    var fopen = $('#physioFinishOpen');
    if (fopen) fopen.addEventListener('click', openPhysioFinishModal);
    bindPhysioCells();
    bindPhysioOpd();
  }

  /** คำนวณรายที่ยังไม่มีวันที่สิ้นสุด (ตามมุมมองที่เลือก) — ตัดทะเบียนซ้ำ */
  function physioFinishList() {
    var d = state.physioData;
    if (!d || !d.rows) return [];
    var type = state.physioType || 'all';
    var isOpdRow = function (r) { return cellVal(r.vn).trim() !== ''; };
    var subset = type === 'opd' ? d.rows.filter(isOpdRow) : (type === 'ipd' ? d.rows.filter(function (r) { return !isOpdRow(r); }) : d.rows);
    var seen = {}, out = [];
    subset.forEach(function (r) {
      var reg = cellVal(r.register_id).trim();
      if (!reg) return;
      if (cellVal(r.date_finish).trim() !== '' || cellVal(r.date_start).trim() === '') return;
      if (seen[reg]) return;
      seen[reg] = true;
      out.push(r);
    });
    return out;
  }

  /** ป็อปอัพ: เลือกคนไข้ที่จะปรับวันที่สิ้นสุด = วันที่เริ่มฟื้นฟู */
  function openPhysioFinishModal() {
    var list = physioFinishList();
    var root = $('#modalRoot');
    if (!list.length) {
      UI.toast('ไม่มีรายการที่ต้องปรับ', 'ทุกรายมีวันที่สิ้นสุดแล้ว', 'ok');
      return;
    }

    var rowsHtml = list.map(function (r) {
      return '<tr>' +
        '<td class="t-center"><input type="checkbox" class="pfchk" data-reg="' + esc(cellVal(r.register_id)) + '" checked></td>' +
        '<td class="t-mono">' + esc(cellVal(r.hn) || '-') + '</td>' +
        '<td>' + esc(cellVal(r.ptname) || '-') + '</td>' +
        '<td class="small nowrap">' + esc(UI.thaiDate(r.date_start) || '-') + '</td>' +
        '<td class="small nowrap" style="color:#b45309;font-weight:700">→ ' + esc(UI.thaiDate(r.date_start) || '-') + '</td>' +
        '<td class="t-mono small">' + esc(cellVal(r.vn) || cellVal(r.an) || '-') + '</td></tr>';
    }).join('');

    root.innerHTML = '<div class="modal-back" id="pfBack"><div class="modal" style="max-width:760px">' +
      '<div class="modal-head"><div><h3 style="font-size:17px">ปรับวันที่สิ้นสุดการรักษา</h3>' +
      '<div class="small muted">ตั้งวันที่สิ้นสุด = วันที่เริ่มฟื้นฟู เฉพาะรายที่ติ๊กเลือก</div></div>' +
      '<button class="x-btn" id="pfClose">✕</button></div>' +
      '<div class="modal-body">' +
      '<div class="flex items-center justify-between mb-8">' +
      '<label class="flex items-center gap-6" style="cursor:pointer"><input type="checkbox" id="pfAll" checked> <span class="small bold">เลือกทั้งหมด</span></label>' +
      '<span class="small muted">ยังไม่มีวันที่สิ้นสุด <b id="pfCount">' + list.length + '</b> ราย</span></div>' +
      '<div class="table-wrap" style="max-height:52vh;overflow:auto"><table class="tbl"><thead><tr>' +
      '<th class="t-center">เลือก</th><th>HN</th><th>ชื่อผู้ป่วย</th><th>วันที่เริ่มฟื้นฟู</th><th>วันที่สิ้นสุด (ใหม่)</th><th>VN/AN</th>' +
      '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div>' +
      '<div class="modal-foot"><span class="tiny muted" style="margin-right:auto">อัพเดท physic_register_dch_date = physic_register_date</span>' +
      '<button class="btn btn-ghost" id="pfCancel">ยกเลิก</button>' +
      '<button class="btn btn-orange" id="pfRun">🗓️ จัดการวันที่สิ้นสุด</button></div>' +
      '</div></div>';

    var close = function () { root.innerHTML = ''; };
    $('#pfClose').addEventListener('click', close);
    $('#pfCancel').addEventListener('click', close);
    $('#pfBack').addEventListener('click', function (e) { if (e.target.id === 'pfBack') close(); });

    $('#pfAll').addEventListener('change', function () {
      var on = this.checked;
      $$('#modalRoot .pfchk').forEach(function (c) { c.checked = on; });
    });

    $('#pfRun').addEventListener('click', async function () {
      var regs = $$('#modalRoot .pfchk').filter(function (c) { return c.checked; }).map(function (c) { return c.dataset.reg; });
      if (!regs.length) { UI.toast('ยังไม่ได้เลือกรายการ', 'ติ๊กเลือกรายที่ต้องการปรับก่อน', 'warn'); return; }
      if (!window.confirm('อัพเดทวันที่สิ้นสุดการรักษา = วันที่เริ่มฟื้นฟู สำหรับ ' + regs.length + ' ทะเบียน?')) return;
      UI.busy(this, true, 'กำลังอัพเดท…');
      try {
        var r = await API.call('save.physiofinish', { regs: regs });
        UI.toast('อัพเดทวันที่สิ้นสุดแล้ว', 'ปรับ ' + UI.num(r.updated || 0) + ' ทะเบียน', 'ok', 5000);
        close();
        refresh();
      } catch (e) {
        if (guardExpiry(e)) return;
        UI.toast('อัพเดทไม่สำเร็จ', e.message, 'err', 6000);
        UI.busy(this, false);
      }
    });
  }

  /** คำนวณกลุ่ม REHAB code (43) ที่ซ้ำภายใน vn เดียว (ตามมุมมองที่เลือก) */
  function physioDupList() {
    var d = state.physioData;
    if (!d || !d.rows) return [];
    var type = state.physioType || 'all';
    var isOpdRow = function (r) { return cellVal(r.vn).trim() !== ''; };
    var subset = type === 'opd' ? d.rows.filter(isOpdRow) : (type === 'ipd' ? d.rows.filter(function (r) { return !isOpdRow(r); }) : d.rows);
    var byKey = {};
    subset.forEach(function (r) {
      var vn = cellVal(r.vn).trim(), code = cellVal(r.rehabcode).trim();
      if (!vn || !code) return;
      var k = vn + '|' + code;
      (byKey[k] = byKey[k] || []).push(r);
    });
    var out = [];
    Object.keys(byKey).forEach(function (k) {
      var g = byKey[k];
      if (g.length < 2) return;
      var r = g[0];
      out.push({ vn: cellVal(r.vn).trim(), code: cellVal(r.rehabcode).trim(), count: g.length, hn: cellVal(r.hn), ptname: cellVal(r.ptname), item_name: cellVal(r.item_name) });
    });
    return out;
  }

  /** ป็อปอัพ: เลือกกลุ่ม REHAB code ซ้ำที่จะรวมเป็นเรคคอร์ดเดียว + บวกจำนวน */
  function openPhysioMergeModal() {
    var list = physioDupList();
    var root = $('#modalRoot');
    if (!list.length) {
      UI.toast('ไม่มี REHAB code ซ้ำ', 'ไม่พบรหัสซ้ำภายใน VN เดียวกัน', 'ok');
      return;
    }

    var rowsHtml = list.map(function (g) {
      return '<tr>' +
        '<td class="t-center"><input type="checkbox" class="pmchk" data-vn="' + esc(g.vn) + '" data-code="' + esc(g.code) + '" checked></td>' +
        '<td class="t-mono">' + esc(g.hn || '-') + '</td>' +
        '<td>' + esc(g.ptname || '-') + '</td>' +
        '<td class="t-mono small bold" style="color:#b45309">' + esc(g.code) + '</td>' +
        '<td class="small">' + esc(g.item_name || '-') + '</td>' +
        '<td class="t-center"><span class="badge badge-peach small">ซ้ำ ' + UI.num(g.count) + '</span></td>' +
        '<td class="t-mono small">' + esc(g.vn) + '</td></tr>';
    }).join('');

    root.innerHTML = '<div class="modal-back" id="pmBack"><div class="modal" style="max-width:800px">' +
      '<div class="modal-head"><div><h3 style="font-size:17px">รวม REHAB code (43) ที่ซ้ำ</h3>' +
      '<div class="small muted">รวมเรคคอร์ดที่ซ้ำใน VN เดียวกันให้เหลือรายการเดียว และบวกจำนวนเข้าด้วยกัน เฉพาะที่ติ๊กเลือก</div></div>' +
      '<button class="x-btn" id="pmClose">✕</button></div>' +
      '<div class="modal-body">' +
      '<div class="flex items-center justify-between mb-8">' +
      '<label class="flex items-center gap-6" style="cursor:pointer"><input type="checkbox" id="pmAll" checked> <span class="small bold">เลือกทั้งหมด</span></label>' +
      '<span class="small muted">พบซ้ำ <b id="pmCount">' + list.length + '</b> กลุ่ม</span></div>' +
      '<div class="table-wrap" style="max-height:52vh;overflow:auto"><table class="tbl"><thead><tr>' +
      '<th class="t-center">เลือก</th><th>HN</th><th>ชื่อผู้ป่วย</th><th>REHAB code</th><th>ชื่อรายการ</th><th class="t-center">จำนวนซ้ำ</th><th>VN</th>' +
      '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div>' +
      '<div class="modal-foot"><span class="tiny muted" style="margin-right:auto">รวม physic_plan_detail_qty แล้วลบเรคคอร์ดซ้ำ</span>' +
      '<button class="btn btn-ghost" id="pmCancel">ยกเลิก</button>' +
      '<button class="btn btn-primary" id="pmRun">🔗 รวม REHAB code ซ้ำ</button></div>' +
      '</div></div>';

    var close = function () { root.innerHTML = ''; };
    $('#pmClose').addEventListener('click', close);
    $('#pmCancel').addEventListener('click', close);
    $('#pmBack').addEventListener('click', function (e) { if (e.target.id === 'pmBack') close(); });

    $('#pmAll').addEventListener('change', function () {
      var on = this.checked;
      $$('#modalRoot .pmchk').forEach(function (c) { c.checked = on; });
    });

    $('#pmRun').addEventListener('click', async function () {
      var pairs = $$('#modalRoot .pmchk').filter(function (c) { return c.checked; })
        .map(function (c) { return { vn: c.dataset.vn, code: c.dataset.code }; });
      if (!pairs.length) { UI.toast('ยังไม่ได้เลือกรายการ', 'ติ๊กเลือกกลุ่มที่ต้องการรวมก่อน', 'warn'); return; }
      if (!window.confirm('รวม REHAB code ซ้ำ ' + pairs.length + ' กลุ่ม เป็นเรคคอร์ดเดียว + บวกจำนวน?')) return;
      UI.busy(this, true, 'กำลังรวม…');
      try {
        var r = await API.call('save.physiomerge', { pairs: pairs });
        UI.toast('รวม REHAB code สำเร็จ', 'รวม ' + UI.num(r.groups || 0) + ' กลุ่ม · ลบซ้ำ ' + UI.num(r.merged || 0) + ' แถว', 'ok', 5000);
        close();
        refresh();
      } catch (e) {
        if (guardExpiry(e)) return;
        UI.toast('รวมไม่สำเร็จ', e.message, 'err', 6000);
        UI.busy(this, false);
      }
    });
  }

  function bindPhysioOpd() {
    $$('#pagePhysio button.pdiagbtn').forEach(function (b) {
      b.addEventListener('click', function () { openDiagModal(b.dataset.vn); });
    });
    var icdT = null;
    $$('#pagePhysio input.popd').forEach(function (inp) {
      inp.dataset.orig = inp.value;
      if (inp.dataset.field === 'pdx') {
        inp.addEventListener('input', function () {
          var q = inp.value.trim();
          clearTimeout(icdT);
          if (q.length < 2) return;
          icdT = setTimeout(async function () {
            try {
              var r = await API.call('data.icd10', { q: q });
              var dl = $('#icdOptionsP');
              if (dl) dl.innerHTML = r.items.map(function (i) { return '<option value="' + esc(i.code) + '">' + esc(i.code) + ' · ' + esc(i.name) + '</option>'; }).join('');
            } catch (e) { /* เงียบ */ }
          }, 300);
        });
      }
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        else if (e.key === 'Escape') { inp.value = inp.dataset.orig; inp.blur(); }
      });
      inp.addEventListener('blur', function () { commitPhysioOpd(inp); });
    });
  }

  async function commitPhysioOpd(inp) {
    var val = String(inp.value).trim();
    if (val === (inp.dataset.orig || '')) return;
    var td = inp.closest('td');
    if (!td.classList.contains('blank')) {
      if (!window.confirm('ช่องนี้มีข้อมูลอยู่แล้ว\n\nเดิม : ' + (inp.dataset.orig || '(ว่าง)') + '\nใหม่ : ' + (val || '(ว่าง)') + '\n\nยืนยันการแก้ไขทับข้อมูลเดิมหรือไม่?')) { inp.value = inp.dataset.orig; return; }
    }
    inp.disabled = true; td.classList.add('saving');
    try {
      var r = await API.call('save.field', { vn: inp.dataset.vn, field: inp.dataset.field, value: val });
      inp.dataset.orig = inp.value = (r.value === null || r.value === undefined) ? val : String(r.value);
      td.classList.remove('blank', 'err'); td.classList.add('saved');
      setTimeout(function () { td.classList.remove('saved'); }, 1200);
      // อัปเดตช่องเดียวกันของ vn เดียวกันในแถวอื่น (physic_list หลายรายการต่อ vn)
      if (r.visit) syncPhysioVn(inp.dataset.vn, inp.dataset.field, inp.value);
    } catch (e) {
      if (guardExpiry(e)) return;
      td.classList.add('err');
      UI.toast('บันทึกไม่สำเร็จ', e.message, 'err', 5000);
      inp.value = inp.dataset.orig;
    } finally {
      inp.disabled = false; td.classList.remove('saving');
    }
  }

  function syncPhysioVn(vn, field, value) {
    $$('#pagePhysio input.popd[data-field="' + field + '"]').forEach(function (o) {
      if (o.dataset.vn === vn) {
        o.dataset.orig = o.value = value;
        var td = o.closest('td');
        var blank = String(value).trim() === '' || ((o.dataset.type === 'int' || o.dataset.type === 'float') && Number(value) === 0);
        td.classList.toggle('blank', blank);
      }
    });
  }

  function bindPhysioCells() {
    $$('#pagePhysio input.pcin').forEach(function (inp) {
      inp.dataset.orig = inp.value;
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        else if (e.key === 'Escape') { inp.value = inp.dataset.orig; inp.blur(); }
      });
      inp.addEventListener('blur', function () { commitPhysio(inp); });
    });
  }

  async function commitPhysio(inp) {
    var val = String(inp.value).trim();
    if (val === (inp.dataset.orig || '')) return;
    var td = inp.closest('td');
    if (!td.classList.contains('blank')) {
      if (!window.confirm('ช่องนี้มีข้อมูลอยู่แล้ว\n\nเดิม : ' + (inp.dataset.orig || '(ว่าง)') + '\nใหม่ : ' + (val || '(ว่าง)') + '\n\nยืนยันการแก้ไขทับข้อมูลเดิมหรือไม่?')) { inp.value = inp.dataset.orig; return; }
    }
    inp.disabled = true; td.classList.add('saving');
    try {
      var r = await API.call('save.physiofield', {
        field: inp.dataset.field, src: inp.dataset.src, pid: inp.dataset.pid,
        items: inp.dataset.items, reg: inp.dataset.reg, hn: inp.dataset.hn, value: val
      });
      inp.dataset.orig = inp.value = (r.value === null || r.value === undefined) ? val : String(r.value);
      td.classList.remove('blank', 'err'); td.classList.add('saved');
      setTimeout(function () { td.classList.remove('saved'); }, 1200);
      if (r.row) applyPhysioRow(inp.dataset.key, r.row);
    } catch (e) {
      if (guardExpiry(e)) return;
      td.classList.add('err');
      UI.toast('บันทึกไม่สำเร็จ', e.message, 'err', 5000);
      inp.value = inp.dataset.orig;
    } finally {
      inp.disabled = false; td.classList.remove('saving');
    }
  }

  function applyPhysioRow(key, row) {
    var tr = document.querySelector('#pagePhysio tr[data-key="' + cssEsc(key) + '"]');
    if (!tr) return;
    var badge = tr.querySelector('.pcbadge');
    if (badge) { badge.textContent = row._percent + '%'; badge.className = 'pcbadge ' + UI.tone(row._percent); }
    (state.physioFields || []).forEach(function (f) {
      var cell = tr.querySelector('.pcin[data-field="' + f.key + '"]');
      if (cell) { cell.closest('td').classList.toggle('blank', row._missing.indexOf(f.key) >= 0); }
    });
  }

  boot();
})();
