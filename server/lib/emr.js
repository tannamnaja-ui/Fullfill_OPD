'use strict';
/** ดึงข้อมูล Patient EMR ของ 1 visit (อ่านอย่างเดียว) — แต่ละส่วนกันพังด้วย try/catch */
const db = require('./db');

async function one(cfg, sql, params) {
  const rows = await db.query(cfg, sql, params);
  return rows.length ? rows[0] : null;
}
async function many(cfg, sql, params) {
  try { return await db.query(cfg, sql, params); } catch (e) { return []; }
}

/** แปลงค่าวันที่ (string/Date) เป็น 'YYYY-MM-DD' เสมอ */
function toISO(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date && !isNaN(v)) {
    return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
  }
  var s = String(v);
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  var d = new Date(s);
  if (!isNaN(d)) return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  return s.slice(0, 10);
}
/** แปลงเวลาเป็น 'HH:MM:SS' */
function toTime(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date && !isNaN(v)) return ('0' + v.getHours()).slice(-2) + ':' + ('0' + v.getMinutes()).slice(-2) + ':' + ('0' + v.getSeconds()).slice(-2);
  var s = String(v);
  var m = s.match(/(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : s.slice(0, 8);
}

function ageOf(birthday) {
  const b = String(birthday || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b)) return '';
  const bd = new Date(b), now = new Date();
  let a = now.getFullYear() - bd.getFullYear();
  const m = now.getMonth() - bd.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < bd.getDate())) a--;
  return (a >= 0 && a < 130) ? (a + ' ปี') : '';
}

/** ส่วนหัว (ผู้ป่วย + การมารับบริการ) */
async function headerOf(cfg, vn) {
  const r = await one(cfg,
    'SELECT o.vn, o.hn, o.vstdate, o.vsttime, o.main_dep AS depcode, o.doctor, o.ovstist, o.ovstost,' +
    ' p.pname, p.fname, p.lname, p.cid, p.birthday,' +
    " COALESCE(k.department,'') AS dep_name," +
    " COALESCE(dc.name,'') AS doctor_name," +
    " COALESCE(sti.name,'') AS ovstist_name," +
    " COALESCE(sto.name,'') AS ovstost_name" +
    ' FROM ovst o' +
    ' LEFT JOIN patient p ON p.hn = o.hn' +
    ' LEFT JOIN kskdepartment k ON k.depcode = o.main_dep' +
    ' LEFT JOIN doctor dc ON dc.code = o.doctor' +
    ' LEFT JOIN ovstist sti ON sti.ovstist = o.ovstist' +
    ' LEFT JOIN ovstost sto ON sto.ovstost = o.ovstost' +
    ' WHERE o.vn = ? LIMIT 1', [vn]);
  if (!r) return null;
  return {
    vn: String(r.vn), hn: String(r.hn || ''),
    ptname: [r.pname, r.fname, r.lname].filter(Boolean).join(' ').trim(),
    age: ageOf(toISO(r.birthday)), cid: r.cid || '',
    vstdate: toISO(r.vstdate), vsttime: toTime(r.vsttime),
    depcode: r.depcode || '', dep_name: r.dep_name || '',
    ovstist_name: r.ovstist_name || '', ovstost_name: r.ovstost_name || '',
    doctor_name: r.doctor_name || '', staff_name: ''
  };
}

/** สัญญาณชีพ/คัดกรอง (opdscreen) — มี fallback ถ้าคอลัมน์ต่าง */
async function screenOf(cfg, vn) {
  const full = 'SELECT cc, bw, height, waist, bmi, temperature, pulse, rr, bps, bpd, o2sat, fbs, pmh FROM opdscreen WHERE vn = ? LIMIT 1';
  const mini = 'SELECT cc, bw, height, bmi, temperature, pulse, rr, bps, bpd, o2sat FROM opdscreen WHERE vn = ? LIMIT 1';
  try { const r = await one(cfg, full, [vn]); return r || {}; }
  catch (e) { try { const r = await one(cfg, mini, [vn]); return r || {}; } catch (e2) { return {}; } }
}

/** การวินิจฉัย ICD-10 */
async function icd10Of(cfg, vn) {
  return many(cfg,
    "SELECT d.icd10, COALESCE(i.name,'') AS icd10_name, COALESCE(dc.name,'') AS doctor_name, d.diagtype" +
    ' FROM ovstdiag d' +
    ' LEFT JOIN icd101 i ON i.code = d.icd10' +
    ' LEFT JOIN doctor dc ON dc.code = d.doctor' +
    ' WHERE d.vn = ? ORDER BY d.diagtype, d.icd10', [vn]);
}

/** รายการยา/เวชภัณฑ์ */
async function medicationOf(cfg, vn) {
  return many(cfg,
    "SELECT COALESCE(di.name, r.icode) AS item_name, r.qty," +
    " COALESCE(doc.name,'') AS doctor_name, '' AS shortlist" +
    ' FROM opitemrec r' +
    ' LEFT JOIN drugitems di ON di.icode = r.icode' +
    ' LEFT JOIN doctor doc ON doc.code = r.doctor' +
    ' WHERE r.vn = ? ORDER BY r.begin_date_time', [vn]);
}

/** ผลแล็บ */
async function labOf(cfg, vn) {
  return many(cfg,
    "SELECT COALESCE(li.lab_items_name, '') AS item_name, lo.lab_order_result AS result," +
    " COALESCE(lo.lab_items_normal_value_ref,'') AS normal_value" +
    ' FROM lab_head lh' +
    ' JOIN lab_order lo ON lo.lab_head_id = lh.lab_head_id' +
    ' LEFT JOIN lab_items li ON li.lab_items_code = lo.lab_items_code' +
    ' WHERE lh.vn = ? ORDER BY lo.lab_order_number', [vn]);
}

/** ผล X-ray */
async function xrayOf(cfg, vn) {
  return many(cfg,
    "SELECT xr.report_text, COALESCE(dc.name,'') AS report_doctor, xr.report_date" +
    ' FROM xray_report xr LEFT JOIN doctor dc ON dc.code = xr.report_doctor' +
    ' WHERE xr.vn = ? ORDER BY xr.report_date', [vn]);
}

/** นัดหมาย */
async function appointmentOf(cfg, vn) {
  return many(cfg,
    "SELECT a.nextdate, COALESCE(k.department,'') AS dep_name, COALESCE(a.app_cause,'') AS app_cause" +
    ' FROM oapp a LEFT JOIN kskdepartment k ON k.depcode = a.clinic' +
    ' WHERE a.vn = ? ORDER BY a.nextdate', [vn]);
}

/** Doctor note */
async function doctorNoteOf(cfg, vn) {
  return many(cfg,
    'SELECT doctor_note AS note_text, entry_datetime AS note_datetime FROM doctor_note WHERE vn = ? ORDER BY entry_datetime', [vn]);
}

/** HPI */
async function hpiOf(cfg, vn) {
  return many(cfg,
    'SELECT hpi AS hpi_text, entry_datetime AS entry_date FROM opd_hpi WHERE vn = ? ORDER BY entry_datetime', [vn]);
}

/** ผลตรวจร่างกาย (PE) */
async function peOf(cfg, vn) {
  try {
    const r = await one(cfg, 'SELECT pe, ga, heent, heart, chest, ab, neuro, ext, gen FROM opdscreen WHERE vn = ? LIMIT 1', [vn]);
    return r || {};
  } catch (e) { return {}; }
}

/** ข้อความวินิจฉัย (Diagnosis Text) */
async function diagTextOf(cfg, vn) {
  return many(cfg,
    'SELECT diagtext AS diag_text, entry_datetime AS diag_datetime FROM ovstdiag_text WHERE vn = ? ORDER BY entry_datetime', [vn]);
}

/** งานทันตกรรม */
async function dentalOf(cfg, vn) {
  return many(cfg, "SELECT COALESCE(detail,'') AS note FROM dtmain WHERE vn = ? ORDER BY reccode", [vn]);
}

/** รวมข้อมูล EMR ของ 1 visit */
async function buildEmr(cfg, vn) {
  const header = await headerOf(cfg, vn);
  if (!header) return { success: false, message: 'ไม่พบข้อมูลของ VN นี้' };
  const [screen, pe, icd10, medication, lab, xray, appointment, doctorNote, hpi, diagText, dental] = await Promise.all([
    screenOf(cfg, vn), peOf(cfg, vn), icd10Of(cfg, vn), medicationOf(cfg, vn),
    labOf(cfg, vn), xrayOf(cfg, vn), appointmentOf(cfg, vn), doctorNoteOf(cfg, vn),
    hpiOf(cfg, vn), diagTextOf(cfg, vn), dentalOf(cfg, vn)
  ]);
  return { success: true, header, screen, pe, hpi, diagText, icd10, medication, lab, xray, doctorNote, appointment, dental };
}

/** รายการ visit ทั้งหมดของผู้ป่วย (ฝั่งซ้าย) */
async function visitsOf(cfg, hn) {
  const items = await many(cfg,
    'SELECT vn, vstdate, vsttime FROM ovst WHERE hn = ? ORDER BY vstdate DESC, vsttime DESC LIMIT 300', [hn]);
  return items.map((v) => ({ vn: String(v.vn), vstdate: toISO(v.vstdate), vsttime: toTime(v.vsttime), hospname: '' }));
}

module.exports = { buildEmr, visitsOf };
