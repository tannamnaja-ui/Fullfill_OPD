'use strict';
/** บันทึกประวัติการเพิ่ม/แก้ไขข้อมูลผ่านระบบ (ใช้แสดงบนแดชบอร์ด "ข้อมูลที่ลงเพิ่ม") */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');

function fileOf(dateStr) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  return path.join(LOG_DIR, 'edits-' + String(dateStr).slice(0, 7) + '.jsonl');
}

function write(entry) {
  const now = new Date();
  const rec = Object.assign({
    at: now.toISOString(),
    day: now.toISOString().slice(0, 10)
  }, entry);
  try {
    fs.appendFileSync(fileOf(rec.day), JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) { /* ไม่ให้ล้มเหลวกระทบการบันทึกข้อมูลหลัก */ }
  return rec;
}

/** อ่านประวัติในช่วงวันที่ (ตามวันที่ของ visit) */
function read(from, to, depCode) {
  const months = new Set();
  const d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  let guard = 0;
  while (d <= end && guard++ < 400) {
    months.add(d.toISOString().slice(0, 7));
    d.setMonth(d.getMonth() + 1);
  }
  months.add(String(to).slice(0, 7));

  const out = [];
  for (const m of months) {
    const f = path.join(LOG_DIR, 'edits-' + m + '.jsonl');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const vd = String(rec.vstdate || rec.day || '');
        if (vd < from || vd > to) continue;
        if (depCode && String(rec.main_dep || '') !== String(depCode)) continue;
        out.push(rec);
      } catch (e) { /* ข้ามบรรทัดเสีย */ }
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** สรุปประวัติสำหรับแดชบอร์ด */
function summary(entries) {
  const byUser = new Map();
  const byField = new Map();
  const vns = new Set();
  for (const e of entries) {
    vns.add(e.vn);
    const u = e.user || '-';
    byUser.set(u, (byUser.get(u) || 0) + (e.fields ? e.fields.length : 1));
    for (const f of (e.fields || [])) byField.set(f, (byField.get(f) || 0) + 1);
  }
  const toArr = (m) => [...m.entries()].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count);
  return {
    entries: entries.length,
    visits: vns.size,
    fields: entries.reduce((s, e) => s + (e.fields ? e.fields.length : 0), 0),
    byUser: toArr(byUser),
    byField: toArr(byField),
    recent: entries.slice(0, 30)
  };
}

module.exports = { write, read, summary, LOG_DIR };
