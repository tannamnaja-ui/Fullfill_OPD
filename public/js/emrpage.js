/* หน้า Patient EMR — ดึงข้อมูลผ่าน API เข้ารหัสของโปรเจกต์นี้ (อ่านอย่างเดียว) */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var vn = new URLSearchParams(location.search).get('vn') || '';
  var emrCurrentVn = null, emrHn = null, emrVisitsLoaded = false;

  if (!API.session()) {
    $('#emrBody').innerHTML = '<div class="emr-none center">กรุณาเข้าสู่ระบบก่อน (เปิดจากหน้าโปรแกรมหลัก)</div>';
    return;
  }

  /* ---------- helpers ---------- */
  function escHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var escAttr = escHtml;
  function txt(v) { return String(v == null ? '' : v).trim(); }
  function num(v) { var t = txt(v); return t === '' ? '' : (isNaN(Number(t)) ? t : String(Number(t))); }
  function clean(v) { return txt(v).replace(/\r\n?/g, '\n').replace(/\f/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
  function toArabic(n) { return String(n); }

  var TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  var TH_MONTH_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  function thaiDate(iso) {
    var s = String(iso || '').slice(0, 10).split('-');
    if (s.length !== 3) return txt(iso);
    return Number(s[2]) + ' ' + TH_MONTH[Number(s[1]) - 1] + ' ' + (Number(s[0]) + 543);
  }
  function thaiDateFull(iso) {
    var s = String(iso || '').slice(0, 10).split('-');
    if (s.length !== 3) return txt(iso);
    return Number(s[2]) + ' ' + TH_MONTH_FULL[Number(s[1]) - 1] + ' ' + (Number(s[0]) + 543);
  }
  function ago(dateStr) {
    var t = String(dateStr || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return '';
    var p = t.split('-').map(Number);
    var then = new Date(p[0], p[1] - 1, p[2]), now = new Date();
    var days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - then) / 86400000);
    if (days <= 0) return 'วันนี้';
    if (days === 1) return 'เมื่อวาน';
    if (days < 31) return days + ' วัน';
    var months = Math.floor(days / 30.44);
    if (months < 12) return months + ' เดือน';
    return Math.floor(days / 365.25) + ' ปี';
  }

  function emrPre(v) { var t = clean(v); return t ? '<div class="emr-pre">' + escHtml(t) + '</div>' : ''; }
  function section(title, inner, green) {
    if (!inner) return '';
    var key = escAttr(title);
    return '<div class="emr-sec' + (green ? ' green' : '') + '" data-sec="' + key + '">' +
      '<span class="t">' + escHtml(title) + '</span>' +
      '<button type="button" class="emr-toggle">ซ่อน</button></div>' +
      '<div class="emr-box" data-sec-body="' + key + '">' + inner + '</div>';
  }
  function table(cols, rowsHtml) {
    if (!rowsHtml) return '';
    return '<div style="overflow-x:auto"><table class="emr-table"><thead><tr>' +
      cols.map(function (c) { return '<th>' + escHtml(c) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
  }
  function notes(arr, textKey, dateKeys) {
    return (arr || []).map(function (r) {
      var body = clean(r[textKey]);
      if (!body) return '';
      var meta = (dateKeys || []).map(function (k) { return txt(r[k]); }).filter(Boolean).join(' ');
      meta = meta ? thaiDate(meta) + (String(meta).length > 10 ? ' ' + String(meta).slice(11, 16) : '') : '';
      return '<div class="emr-note">' + emrPre(body) + (meta ? '<div class="emr-meta">' + escHtml(meta) + '</div>' : '') + '</div>';
    }).filter(Boolean).join('');
  }

  /* ---------- render ---------- */
  function renderEmr(d) {
    var h = d.header || {};
    $('#emrPatient').textContent = [h.hn ? 'HN ' + h.hn : '', h.ptname || ''].filter(Boolean).join('  ');
    var kv = function (k, v) { return txt(v) ? '<span class="emr-key">' + escHtml(k) + ' :</span> <span class="emr-val">' + escHtml(txt(v)) + '</span>' : ''; };
    var line = function (parts) { return parts.filter(Boolean).join('&nbsp;&nbsp; '); };
    var out = '';

    out += section('ผู้รับบริการ', line([kv('HN', h.hn), kv('ชื่อ', h.ptname), kv('อายุ', h.age), kv('CID', h.cid)]));
    out += section('การมารับบริการ', line([
      kv('วันที่มา', thaiDate(h.vstdate)), kv('เวลา', String(h.vsttime || '').slice(0, 8)),
      kv('ชนิดการมา', h.ovstist_name),
      kv('แผนก', [txt(h.depcode), txt(h.dep_name)].filter(Boolean).join(' ')),
      kv('สถานะ', h.ovstost_name), kv('แพทย์', h.doctor_name)
    ]));

    var sc = d.screen || {};
    out += section('Chief complaint', emrPre(sc.cc));
    var vs = [['BW', sc.bw, 'Kgs.'], ['Height', sc.height, 'Cm.'], ['Waist', sc.waist, ''], ['BMI', sc.bmi, ''],
      ['Temp', sc.temperature, ''], ['PR', sc.pulse, ''], ['RR', sc.rr, ''],
      ['BP', (txt(sc.bps) && txt(sc.bpd)) ? (num(sc.bps) + '/' + num(sc.bpd)) : '', ''],
      ['O2sat', sc.o2sat, ''], ['FBS', sc.fbs, '']]
      .filter(function (a) { return txt(a[1]); })
      .map(function (a) { return '<span class="emr-key">' + escHtml(a[0]) + ' :</span> <span class="emr-val">' + escHtml(num(a[1])) + (a[2] ? ' ' + escHtml(a[2]) : '') + '</span>'; });
    out += section('Vital sign', vs.length ? vs.join('&nbsp;&nbsp; ') : '');

    out += section('HPI', notes(d.hpi || [], 'hpi_text', ['entry_date']));
    out += section('PMH', emrPre(sc.pmh));

    var pe = d.pe || {};
    var peParts = [['GA', pe.ga], ['HEENT', pe.heent], ['Heart', pe.heart], ['Chest', pe.chest],
      ['Abdomen', pe.ab], ['Neuro', pe.neuro], ['Extremities', pe.ext], ['Genital', pe.gen]]
      .filter(function (a) { return clean(a[1]); })
      .map(function (a) { return '<div class="emr-note"><span class="emr-key">' + escHtml(a[0]) + ':</span> ' + escHtml(clean(a[1])) + '</div>'; });
    out += section('PE', [emrPre(pe.pe), peParts.join('')].filter(Boolean).join(''));

    out += section('Diagnosis Text', notes(d.diagText || [], 'diag_text', ['diag_datetime']));

    out += section('Diagnosis ICD10', table(['ลำดับ', 'รหัส ICD', 'คำอธิบาย', 'ผู้วินิจฉัย', 'ประเภท'],
      (d.icd10 || []).map(function (r, i) {
        return '<tr><td class="num">' + (i + 1) + '</td><td><strong>' + escHtml(txt(r.icd10)) + '</strong></td>' +
          '<td>' + escHtml(txt(r.icd10_name)) + '</td><td>' + escHtml(txt(r.doctor_name)) + '</td>' +
          '<td>' + escHtml(txt(r.diagtype_name) || txt(r.diagtype)) + '</td></tr>';
      }).join('')));

    out += section('Medication', table(['ลำดับ', 'ชื่อรายการ', 'จำนวน', 'วิธีใช้', 'ผู้สั่ง'],
      (d.medication || []).map(function (r, i) {
        return '<tr><td class="num">' + (i + 1) + '</td><td>' + escHtml(txt(r.item_name)) + '</td>' +
          '<td class="num">' + escHtml(num(r.qty)) + '</td><td>' + escHtml(txt(r.shortlist)) + '</td>' +
          '<td>' + escHtml(txt(r.doctor_name)) + '</td></tr>';
      }).join('')), true);

    out += section('Laboratory Test', table(['ลำดับ', 'รายการตรวจ', 'ผล', 'ค่าปกติ'],
      (d.lab || []).map(function (r, i) {
        return '<tr><td class="num">' + (i + 1) + '</td><td>' + escHtml(txt(r.item_name)) + '</td>' +
          '<td><strong>' + escHtml(txt(r.result)) + '</strong></td><td>' + escHtml(txt(r.normal_value)) + '</td></tr>';
      }).join('')));

    out += section('Radiology Test', (d.xray || []).map(function (r) {
      var body = clean(r.report_text); if (!body) return '';
      var meta = [txt(r.report_doctor), thaiDate(r.report_date)].filter(Boolean).join(' · ');
      return '<div class="emr-note">' + emrPre(body) + (meta ? '<div class="emr-meta">' + escHtml(meta) + '</div>' : '') + '</div>';
    }).filter(Boolean).join(''));

    out += section('Doctor Note', notes(d.doctorNote || [], 'note_text', ['note_datetime']));

    out += section('Appointment', table(['ลำดับ', 'วันที่นัด', 'แผนก', 'เรื่องที่นัด'],
      (d.appointment || []).map(function (r, i) {
        return '<tr><td class="num">' + (i + 1) + '</td><td>' + escHtml(thaiDate(r.nextdate)) + '</td>' +
          '<td>' + escHtml(txt(r.dep_name)) + '</td><td>' + escHtml(txt(r.app_cause)) + '</td></tr>';
      }).join('')));

    out += section('Dental', (d.dental || []).map(function (r) { return emrPre(r.note); }).filter(Boolean).join(''));

    return out || '<div class="emr-none center">ไม่มีข้อมูลสำหรับ VN นี้</div>';
  }

  /* ---------- toggles ---------- */
  function setupToggles() {
    document.querySelectorAll('.emr-sec[data-sec]').forEach(function (head) {
      var key = head.getAttribute('data-sec');
      var body = document.querySelector('.emr-box[data-sec-body="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
      var btn = head.querySelector('.emr-toggle');
      if (!body || !btn) return;
      btn.addEventListener('click', function () {
        var hidden = body.hasAttribute('hidden');
        if (hidden) { body.removeAttribute('hidden'); head.classList.remove('collapsed'); btn.textContent = 'ซ่อน'; }
        else { body.setAttribute('hidden', ''); head.classList.add('collapsed'); btn.textContent = 'แสดง'; }
      });
    });
  }
  function setupToggleAll() {
    var allBtn = $('#emrToggleAll');
    if (!allBtn) return;
    allBtn.onclick = function () {
      var heads = [].slice.call(document.querySelectorAll('.emr-sec[data-sec]'));
      var anyOpen = heads.some(function (h) {
        var b = document.querySelector('.emr-box[data-sec-body="' + (window.CSS && CSS.escape ? CSS.escape(h.getAttribute('data-sec')) : h.getAttribute('data-sec')) + '"]');
        return b && !b.hasAttribute('hidden');
      });
      heads.forEach(function (h) {
        var b = document.querySelector('.emr-box[data-sec-body="' + (window.CSS && CSS.escape ? CSS.escape(h.getAttribute('data-sec')) : h.getAttribute('data-sec')) + '"]');
        var btn = h.querySelector('.emr-toggle');
        if (!b) return;
        if (anyOpen) { b.setAttribute('hidden', ''); h.classList.add('collapsed'); if (btn) btn.textContent = 'แสดง'; }
        else { b.removeAttribute('hidden'); h.classList.remove('collapsed'); if (btn) btn.textContent = 'ซ่อน'; }
      });
      allBtn.textContent = anyOpen ? 'แสดงทุกหัวข้อ' : 'ซ่อนทุกหัวข้อ';
    };
  }

  /* ---------- load ---------- */
  async function loadEmr(showVn) {
    var target = showVn || vn;
    $('#emrVn').textContent = 'VN: ' + target;
    $('#emrBody').innerHTML = '<div class="center"><span class="spin"></span></div>';
    try {
      var d = await API.call('data.emr', { vn: target });
      if (!d.success) { $('#emrBody').innerHTML = '<div class="emr-none center">' + escHtml(d.message || 'โหลดข้อมูลไม่สำเร็จ') + '</div>'; return; }
      emrHn = (d.header && d.header.hn) || emrHn;
      $('#emrBody').innerHTML = renderEmr(d);
      setupToggles(); setupToggleAll();
      if (!emrVisitsLoaded) loadVisits();
    } catch (e) {
      $('#emrBody').innerHTML = '<div class="emr-none center">เกิดข้อผิดพลาด: ' + escHtml(e.message) + '</div>';
    }
  }

  async function loadVisits() {
    var el = $('#emrVisits');
    if (!emrHn) { el.innerHTML = '<div class="emr-none" style="padding:12px">ไม่พบ HN</div>'; return; }
    emrVisitsLoaded = true;
    try {
      var d = await API.call('data.emrvisits', { hn: emrHn });
      var items = (d && d.items) || [];
      if (!items.length) { el.innerHTML = '<div class="emr-none" style="padding:12px">ไม่พบประวัติการมารับบริการ</div>'; return; }
      el.innerHTML = items.map(function (v) {
        var meta = [ago(v.vstdate), txt(v.hospname)].filter(Boolean).join(' · ');
        return '<button type="button" class="emr-visit' + (v.vn === emrCurrentVn ? ' active' : '') + '" data-vn="' + escAttr(v.vn) + '">' +
          '<div class="vd">' + escHtml(thaiDateFull(v.vstdate)) + ' ' + escHtml(String(v.vsttime || '').slice(0, 5)) + ' น.</div>' +
          '<div class="vm">' + escHtml(meta) + '</div></button>';
      }).join('');
      [].slice.call(el.querySelectorAll('.emr-visit')).forEach(function (btn) {
        btn.addEventListener('click', function () {
          emrCurrentVn = btn.dataset.vn;
          [].slice.call(el.querySelectorAll('.emr-visit')).forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          loadEmr(emrCurrentVn);
        });
      });
    } catch (e) {
      el.innerHTML = '<div class="emr-none" style="padding:12px">โหลดรายการไม่สำเร็จ: ' + escHtml(e.message) + '</div>';
    }
  }

  if (!vn) {
    $('#emrBody').innerHTML = '<div class="emr-none center">ไม่ได้ระบุ VN ใน URL</div>';
    $('#emrVisits').innerHTML = '';
  } else {
    emrCurrentVn = vn;
    loadEmr(vn);
  }
})();
