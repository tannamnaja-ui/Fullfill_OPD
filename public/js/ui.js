/* ตัวช่วย UI ที่ใช้ร่วมกันทุกหน้า */
(function (global) {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(title, msg, kind, ms) {
    var box = $('#toasts');
    if (!box) return;
    var icons = { ok: '✅', err: '⛔', warn: '⚠️', info: '💜' };
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.innerHTML = '<span style="font-size:17px;line-height:1.2">' + (icons[kind] || icons.info) + '</span>' +
      '<div style="flex:1"><div class="ttl">' + esc(title) + '</div>' +
      (msg ? '<div class="msg">' + esc(msg) + '</div>' : '') + '</div>';
    box.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      setTimeout(function () { el.remove(); }, 320);
    }, ms || 4200);
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset.html = btn.dataset.html || btn.innerHTML;
      btn.disabled = true;
      var dark = btn.classList.contains('btn-primary') ? '' : ' dark';
      btn.innerHTML = '<span class="spin' + dark + '"></span> ' + (label || 'กำลังทำงาน…');
    } else {
      btn.disabled = false;
      if (btn.dataset.html) btn.innerHTML = btn.dataset.html;
    }
  }

  /** วันที่วันนี้ในรูปแบบ YYYY-MM-DD (เขตเวลาเครื่อง) */
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  var TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

  /** 2026-08-27 -> 27 ส.ค. 2569 */
  function thaiDate(iso) {
    if (!iso) return '-';
    var p = String(iso).slice(0, 10).split('-');
    if (p.length !== 3) return iso;
    return Number(p[2]) + ' ' + TH_MONTH[Number(p[1]) - 1] + ' ' + (Number(p[0]) + 543);
  }

  function num(n) {
    return Number(n || 0).toLocaleString('th-TH');
  }

  /** อายุจากวันเกิด */
  function ageOf(birthday) {
    if (!birthday) return '';
    var b = new Date(String(birthday).slice(0, 10));
    if (isNaN(b)) return '';
    var t = new Date(), a = t.getFullYear() - b.getFullYear();
    var m = t.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
    return a >= 0 && a < 130 ? a + ' ปี' : '';
  }

  /** สีตามเปอร์เซ็นต์ความสมบูรณ์ */
  function tone(pct) {
    if (pct >= 90) return 'mint';
    if (pct >= 70) return 'sky';
    if (pct >= 50) return 'peach';
    return 'rose';
  }

  global.UI = {
    $: $, $$: $$, esc: esc, toast: toast, busy: busy,
    todayStr: todayStr, thaiDate: thaiDate, num: num, ageOf: ageOf, tone: tone
  };
})(window);
