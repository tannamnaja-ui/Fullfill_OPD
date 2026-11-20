'use strict';
/** คำสั่ง SQL + กฎการตรวจสอบความสมบูรณ์ข้อมูลผู้รับบริการ OPD */
const db = require('./db');

/** ตัวช่วยรองรับความต่างของ dialect: {{D}} = พารามิเตอร์ชนิดวันที่ */
function sqlFor(cfg, tpl) {
  return cfg.driver === 'postgres' ? tpl.replace(/\{\{D\}\}/g, '?::date') : tpl.replace(/\{\{D\}\}/g, '?');
}

/* ---------------- กฎความสมบูรณ์ 12 รายการ ---------------- */
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const has = (v) => !(v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '0');

const RULES = [
  { key: 'cid', label: 'เลขบัตรประชาชน', group: 'ข้อมูลผู้ป่วย', editable: false,
    check: (r) => /^\d{13}$/.test(String(r.cid || '').trim()) },
  { key: 'pttype', label: 'สิทธิการรักษา', group: 'การมารับบริการ', editable: true,
    check: (r) => has(r.pttype) },
  { key: 'doctor', label: 'ผู้ให้บริการ / แพทย์', group: 'การมารับบริการ', editable: true,
    check: (r) => has(r.doctor) },
  { key: 'ovstost', label: 'สถานะ / ผลการรักษา', group: 'การมารับบริการ', editable: true,
    check: (r) => has(r.ovstost) },
  { key: 'cc', label: 'อาการสำคัญ (CC)', group: 'คัดกรอง', editable: true,
    check: (r) => String(r.cc || '').trim().length >= 2 },
  { key: 'bp', label: 'ความดันโลหิต', group: 'สัญญาณชีพ', editable: true,
    check: (r) => num(r.bps) > 0 && num(r.bpd) > 0 },
  { key: 'pulse', label: 'ชีพจร', group: 'สัญญาณชีพ', editable: true,
    check: (r) => num(r.pulse) > 0 },
  { key: 'rr', label: 'อัตราการหายใจ', group: 'สัญญาณชีพ', editable: true,
    check: (r) => num(r.rr) > 0 },
  { key: 'temp', label: 'อุณหภูมิร่างกาย', group: 'สัญญาณชีพ', editable: true,
    check: (r) => num(r.temperature) > 0 },
  { key: 'bwht', label: 'น้ำหนัก / ส่วนสูง', group: 'คัดกรอง', editable: true,
    check: (r) => num(r.bw) > 0 && num(r.height) > 0 },
  { key: 'dx', label: 'การวินิจฉัย (ICD-10)', group: 'การรักษา', editable: true,
    check: (r) => num(r.dx_count) > 0 },
  { key: 'item', label: 'ยา / หัตถการ / ค่าบริการ', group: 'การรักษา', editable: false,
    check: (r) => num(r.item_count) > 0 }
];

const RULE_META = RULES.map((r) => ({ key: r.key, label: r.label, group: r.group, editable: r.editable }));

/** ประเมิน 1 visit */
function evaluate(row) {
  const missing = [];
  for (const rule of RULES) {
    let ok = false;
    try { ok = !!rule.check(row); } catch (e) { ok = false; }
    if (!ok) missing.push(rule.key);
  }
  const score = RULES.length - missing.length;
  return {
    missing, score, total: RULES.length,
    percent: Math.round((score / RULES.length) * 100),
    complete: missing.length === 0
  };
}

/* ---------------- Queries ---------------- */

/** จุดบริการที่มีผู้รับบริการในช่วงวันที่ (ovst.main_dep เทียบ kskdepartment) */
async function departments(cfg, from, to) {
  const sql = sqlFor(cfg, [
    "SELECT o.main_dep AS dep_code,",
    "       COALESCE(MAX(k.department), CONCAT('จุดบริการ ', o.main_dep)) AS dep_name,",
    "       COUNT(*) AS visit_count",
    "  FROM ovst o",
    "  LEFT JOIN kskdepartment k ON k.depcode = o.main_dep",
    " WHERE o.vstdate BETWEEN {{D}} AND {{D}}",
    " GROUP BY o.main_dep",
    " ORDER BY COUNT(*) DESC"
  ].join('\n'));
  const rows = await db.query(cfg, sql, [from, to]);
  return rows.map((r) => ({
    dep_code: r.dep_code === null ? '' : String(r.dep_code),
    dep_name: r.dep_name || ('จุดบริการ ' + r.dep_code),
    visit_count: Number(r.visit_count) || 0
  }));
}

const VISIT_SELECT = [
  "SELECT o.vn, o.hn, o.vstdate, o.vsttime, o.main_dep, o.pttype, o.doctor, o.spclty, o.ovstost,",
  "       p.pname, p.fname, p.lname, p.cid, p.birthday, p.sex,",
  "       s.bps, s.bpd, s.pulse, s.rr, s.temperature, s.bw, s.height, s.o2sat, s.cc,",
  "       COALESCE(k.department, CONCAT('จุดบริการ ', o.main_dep)) AS dep_name,",
  "       (SELECT COUNT(*) FROM ovstdiag d WHERE d.vn = o.vn) AS dx_count,",
  "       (SELECT COUNT(*) FROM opitemrec r WHERE r.vn = o.vn) AS item_count",
  "  FROM ovst o",
  "  LEFT JOIN patient p ON p.hn = o.hn",
  "  LEFT JOIN opdscreen s ON s.vn = o.vn",
  "  LEFT JOIN kskdepartment k ON k.depcode = o.main_dep"
].join('\n');

function decorate(r) {
  const ev = evaluate(r);
  return Object.assign({}, r, {
    vstdate: String(r.vstdate).slice(0, 10),
    vsttime: String(r.vsttime || '').slice(0, 8),
    full_name: [r.pname, r.fname, r.lname].filter(Boolean).join(' ').trim(),
    _missing: ev.missing, _score: ev.score, _percent: ev.percent, _complete: ev.complete
  });
}

/** ดึงรายการ visit ในช่วงวันที่ (กรองจุดบริการได้) */
async function visits(cfg, from, to, depCode, limit) {
  let sql = VISIT_SELECT + '\n WHERE o.vstdate BETWEEN {{D}} AND {{D}}';
  const params = [from, to];
  if (depCode) { sql += ' AND o.main_dep = ?'; params.push(depCode); }
  sql += ' ORDER BY o.vstdate, o.vsttime, o.vn';
  sql += ' LIMIT ' + Math.min(parseInt(limit, 10) || 5000, 20000);
  const rows = await db.query(cfg, sqlFor(cfg, sql), params);
  return rows.map(decorate);
}

/** อ่าน visit เดียว */
async function getVisit(cfg, vn) {
  const rows = await db.query(cfg, VISIT_SELECT + '\n WHERE o.vn = ? LIMIT 1', [vn]);
  return rows.length ? decorate(rows[0]) : null;
}

/** สรุปสำหรับแดชบอร์ด */
function summarize(rows) {
  const byDep = new Map();
  const missCount = {};
  RULES.forEach((r) => { missCount[r.key] = 0; });
  let complete = 0, scoreSum = 0;

  for (const r of rows) {
    if (r._complete) complete++;
    scoreSum += r._score;
    for (const m of r._missing) missCount[m]++;
    const code = r.main_dep === null ? '' : String(r.main_dep);
    if (!byDep.has(code)) {
      byDep.set(code, { dep_code: code, dep_name: r.dep_name || ('จุดบริการ ' + code), total: 0, complete: 0, scoreSum: 0 });
    }
    const d = byDep.get(code);
    d.total++; d.scoreSum += r._score;
    if (r._complete) d.complete++;
  }

  const deps = [...byDep.values()].map((d) => ({
    dep_code: d.dep_code, dep_name: d.dep_name, total: d.total, complete: d.complete,
    incomplete: d.total - d.complete,
    percent: d.total ? Math.round((d.scoreSum / (d.total * RULES.length)) * 100) : 0
  })).sort((a, b) => b.total - a.total);

  const items = RULES.map((r) => ({
    key: r.key, label: r.label, group: r.group,
    missing: missCount[r.key],
    filled: rows.length - missCount[r.key],
    percent: rows.length ? Math.round(((rows.length - missCount[r.key]) / rows.length) * 100) : 0
  })).sort((a, b) => b.missing - a.missing);

  return {
    total: rows.length,
    complete,
    incomplete: rows.length - complete,
    percent: rows.length ? Math.round((scoreSum / (rows.length * RULES.length)) * 100) : 0,
    deps, items, rules: RULE_META
  };
}

/* ---------------- ตารางอ้างอิง ---------------- */
const LOOKUP_SQL = {
  doctor: 'SELECT code AS code, name AS name FROM doctor ORDER BY name',
  pttype: 'SELECT pttype AS code, name AS name FROM pttype ORDER BY pttype',
  ovstost: 'SELECT ovstost AS code, name AS name FROM ovstost ORDER BY ovstost'
};

async function lookup(cfg, name) {
  if (!LOOKUP_SQL[name]) return [];
  try {
    const rows = await db.query(cfg, LOOKUP_SQL[name], []);
    return rows.map((r) => ({ code: String(r.code === null || r.code === undefined ? '' : r.code), name: r.name || '' }));
  } catch (e) { return []; }
}

/** คำนำหน้าชื่อที่นับเป็นแพทย์/ทันตแพทย์ (ชื่อขึ้นต้นด้วยคำเหล่านี้) */
const DOCTOR_PREFIX = ['นพ', 'พญ', 'ทพ', 'น.พ', 'พ.ญ', 'ท.', 'ทพญ', 'ก.'];

/** ค้นหาแพทย์ (active='Y' + ชื่อขึ้นต้นด้วยคำนำหน้าแพทย์) ด้วยชื่อ/นามสกุล/licenseno แบบเรียลไทม์ */
async function searchDoctors(cfg, term, limit) {
  const t = String(term || '').trim();
  const lim = Math.min(parseInt(limit, 10) || 30, 100);
  const params = DOCTOR_PREFIX.map((p) => p + '%');
  let sql = "SELECT code, name, licenseno FROM doctor WHERE active = 'Y' AND (" +
    DOCTOR_PREFIX.map(() => 'name LIKE ?').join(' OR ') + ')';
  if (t) {
    sql += ' AND (name LIKE ? OR licenseno LIKE ? OR code LIKE ?)';
    const q = '%' + t + '%';
    params.push(q, q, q);
  }
  sql += ' ORDER BY name LIMIT ' + lim;
  try {
    const rows = await db.query(cfg, sql, params);
    return rows.map((r) => ({ code: String(r.code === null ? '' : r.code), name: r.name || '', licenseno: r.licenseno || '' }));
  } catch (e) { return []; }
}

/** ค้นหา ICD-10 */
async function searchIcd10(cfg, term) {
  const q = '%' + String(term || '').trim() + '%';
  try {
    const rows = await db.query(cfg,
      'SELECT code, name FROM icd101 WHERE code LIKE ? OR name LIKE ? ORDER BY code LIMIT 40', [q, q]);
    return rows.map((r) => ({ code: r.code, name: r.name }));
  } catch (e) { return []; }
}

/** รายการวินิจฉัยของ visit */
async function diagsOf(cfg, vn) {
  try {
    return await db.query(cfg,
      "SELECT d.icd10, d.diagtype, COALESCE(i.name,'') AS name FROM ovstdiag d " +
      'LEFT JOIN icd101 i ON i.code = d.icd10 WHERE d.vn = ? ORDER BY d.diagtype, d.icd10', [vn]);
  } catch (e) { return []; }
}

/** รายการวินิจฉัยแบบเต็ม (ทุกเรคคอร์ดของ vn) — มี fallback ถ้า schema ต่างออกไป */
async function diagsFull(cfg, vn) {
  // แบบเต็ม: ชื่อโรค + ชื่อแพทย์
  try {
    const rows = await db.query(cfg,
      "SELECT d.icd10, d.diagtype, COALESCE(i.name,'') AS name, d.doctor, COALESCE(dc.name,'') AS doctor_name " +
      'FROM ovstdiag d ' +
      'LEFT JOIN icd101 i ON i.code = d.icd10 ' +
      'LEFT JOIN doctor dc ON dc.code = d.doctor ' +
      'WHERE d.vn = ? ORDER BY d.diagtype, d.icd10', [vn]);
    return rows.map((r) => ({
      icd10: r.icd10, diagtype: String(r.diagtype === null ? '' : r.diagtype),
      name: r.name || '', doctor: String(r.doctor === null ? '' : r.doctor), doctor_name: r.doctor_name || ''
    }));
  } catch (e1) { /* ลองแบบไม่มี doctor join */ }
  try {
    const rows = await db.query(cfg,
      "SELECT d.icd10, d.diagtype, COALESCE(i.name,'') AS name " +
      'FROM ovstdiag d LEFT JOIN icd101 i ON i.code = d.icd10 ' +
      'WHERE d.vn = ? ORDER BY d.diagtype, d.icd10', [vn]);
    return rows.map((r) => ({
      icd10: r.icd10, diagtype: String(r.diagtype === null ? '' : r.diagtype),
      name: r.name || '', doctor: '', doctor_name: ''
    }));
  } catch (e2) { /* ขั้นต่ำสุด: เอาทุกคอลัมน์ของ ovstdiag */ }
  const rows = await db.query(cfg, 'SELECT * FROM ovstdiag WHERE vn = ? ORDER BY diagtype', [vn]);
  return rows.map((r) => ({
    icd10: r.icd10 || r.ICD10 || '', diagtype: String(r.diagtype === null || r.diagtype === undefined ? '' : r.diagtype),
    name: '', doctor: String(r.doctor === null || r.doctor === undefined ? '' : r.doctor), doctor_name: ''
  }));
}

/** แพทย์เริ่มต้นของ visit (ovst.doctor) พร้อมชื่อ */
async function getVisitDoctor(cfg, vn) {
  try {
    const rows = await db.query(cfg,
      "SELECT o.doctor AS code, COALESCE(dc.name,'') AS name " +
      'FROM ovst o LEFT JOIN doctor dc ON dc.code = o.doctor WHERE o.vn = ? LIMIT 1', [vn]);
    if (!rows.length) return { code: '', name: '' };
    return { code: String(rows[0].code === null || rows[0].code === undefined ? '' : rows[0].code), name: rows[0].name || '' };
  } catch (e) { return { code: '', name: '' }; }
}

/** เพิ่มวินิจฉัยด้วย vn (ดึง hn/vstdate จาก ovst ให้เอง) */
async function addDiagVn(cfg, vn, icd10, diagtype, doctorCode) {
  const ov = await db.query(cfg, 'SELECT hn, vstdate FROM ovst WHERE vn = ? LIMIT 1', [vn]);
  if (!ov.length) { const e = new Error('ไม่พบ visit นี้'); e.status = 404; throw e; }
  const visit = { vn: String(vn), hn: ov[0].hn, vstdate: String(ov[0].vstdate).slice(0, 10) };
  return addDiag(cfg, visit, icd10, diagtype, doctorCode);
}

/** เปลี่ยนประเภทการวินิจฉัย (เจาะจงเรคคอร์ดด้วย diagtype เดิม) */
async function updateDiagType(cfg, vn, icd10, oldType, newType) {
  const code = String(icd10 || '').trim().toUpperCase();
  const nt = String(newType || '').trim();
  if (!code || !nt) { const e = new Error('ข้อมูลไม่ครบ'); e.status = 400; throw e; }
  const ot = String(oldType || '').trim();
  if (ot) return db.execute(cfg, 'UPDATE ovstdiag SET diagtype = ? WHERE vn = ? AND icd10 = ? AND diagtype = ?', [nt, String(vn), code, ot]);
  return db.execute(cfg, 'UPDATE ovstdiag SET diagtype = ? WHERE vn = ? AND icd10 = ?', [nt, String(vn), code]);
}

/** เปลี่ยนแพทย์ของการวินิจฉัย (เจาะจงเรคคอร์ดด้วย icd10 + diagtype) */
async function updateDiagDoctor(cfg, vn, icd10, diagtype, doctor) {
  const code = String(icd10 || '').trim().toUpperCase();
  const dc = String(doctor || '').trim();
  if (!code) { const e = new Error('ไม่ได้ระบุรหัส ICD-10'); e.status = 400; throw e; }
  if (!dc) { const e = new Error('กรุณาเลือกแพทย์'); e.status = 400; throw e; }
  const dt = String(diagtype || '').trim();
  if (dt) return db.execute(cfg, 'UPDATE ovstdiag SET doctor = ? WHERE vn = ? AND icd10 = ? AND diagtype = ?', [dc, String(vn), code, dt]);
  return db.execute(cfg, 'UPDATE ovstdiag SET doctor = ? WHERE vn = ? AND icd10 = ?', [dc, String(vn), code]);
}

/** ลบวินิจฉัย (เจาะจงเรคคอร์ดด้วย diagtype ถ้าระบุ) */
async function deleteDiag(cfg, vn, icd10, diagtype) {
  const code = String(icd10 || '').trim().toUpperCase();
  if (!code) { const e = new Error('ไม่ได้ระบุรหัส ICD-10'); e.status = 400; throw e; }
  const dt = String(diagtype || '').trim();
  if (dt) return db.execute(cfg, 'DELETE FROM ovstdiag WHERE vn = ? AND icd10 = ? AND diagtype = ?', [String(vn), code, dt]);
  return db.execute(cfg, 'DELETE FROM ovstdiag WHERE vn = ? AND icd10 = ?', [String(vn), code]);
}

const N = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

/** บันทึกสัญญาณชีพ / คัดกรอง ลง opdscreen (ถ้าไม่มีแถวจะสร้างใหม่) */
async function saveScreen(cfg, visit, data) {
  const f = {
    bps: N(data.bps), bpd: N(data.bpd), pulse: N(data.pulse), rr: N(data.rr),
    temperature: N(data.temperature), bw: N(data.bw), height: N(data.height),
    o2sat: N(data.o2sat),
    cc: data.cc === undefined || String(data.cc).trim() === '' ? null : String(data.cc)
  };
  const cols = Object.keys(f).filter((k) => f[k] !== null);
  if (!cols.length) return { affected: 0 };

  const exists = await db.query(cfg, 'SELECT vn FROM opdscreen WHERE vn = ? LIMIT 1', [visit.vn]);
  if (exists.length) {
    const sql = 'UPDATE opdscreen SET ' + cols.map((c) => c + ' = ?').join(', ') + ' WHERE vn = ?';
    return db.execute(cfg, sql, cols.map((c) => f[c]).concat([visit.vn]));
  }
  const insCols = ['vn', 'hn', 'vstdate', 'vsttime'].concat(cols);
  const insVals = [visit.vn, visit.hn, visit.vstdate, visit.vsttime || '00:00:00'].concat(cols.map((c) => f[c]));
  const sql = 'INSERT INTO opdscreen (' + insCols.join(', ') + ') VALUES (' + insCols.map(() => '?').join(', ') + ')';
  return db.execute(cfg, sql, insVals);
}

/** บันทึกข้อมูลการมารับบริการ ลง ovst */
async function saveVisitFields(cfg, vn, data) {
  const f = {};
  if (data.pttype !== undefined && String(data.pttype) !== '') f.pttype = String(data.pttype);
  if (data.doctor !== undefined && String(data.doctor) !== '') f.doctor = String(data.doctor);
  if (data.ovstost !== undefined && String(data.ovstost) !== '') f.ovstost = String(data.ovstost);
  const cols = Object.keys(f);
  if (!cols.length) return { affected: 0 };
  const sql = 'UPDATE ovst SET ' + cols.map((c) => c + ' = ?').join(', ') + ' WHERE vn = ?';
  return db.execute(cfg, sql, cols.map((c) => f[c]).concat([vn]));
}

/** เพิ่มการวินิจฉัยลง ovstdiag */
async function addDiag(cfg, visit, icd10, diagtype, doctorCode) {
  const code = String(icd10 || '').trim().toUpperCase();
  if (!code) throw new Error('ไม่ได้ระบุรหัส ICD-10');
  const dup = await db.query(cfg, 'SELECT vn FROM ovstdiag WHERE vn = ? AND icd10 = ? LIMIT 1', [visit.vn, code]);
  if (dup.length) return { affected: 0, duplicated: true };
  const cols = ['vn', 'hn', 'vstdate', 'icd10', 'diagtype'];
  const vals = [visit.vn, visit.hn, visit.vstdate, code, String(diagtype || '1')];
  if (doctorCode) { cols.push('doctor'); vals.push(String(doctorCode)); }
  const sql = 'INSERT INTO ovstdiag (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')';
  return db.execute(cfg, sql, vals);
}

/* ============================================================
 * หน้า "ตรวจสอบและเพิ่มข้อมูล" — ใช้คิวรี่ตามที่กำหนด
 * 9 ฟิลด์ที่แก้ไขได้ในช่อง (null/ว่าง = สีแดง) แล้วบันทึกกลับฟิลด์เดิมทันที
 * ============================================================ */

/** ฟิลด์ที่แก้ไขได้ inline -> ตาราง/คอลัมน์จริง + ชนิดข้อมูล */
const CHECK_FIELDS = {
  hospmain:    { table: 'vn_stat',   col: 'hospmain',    type: 'text',  label: 'รพ.หลัก (สิทธิ)' },
  pdx:         { table: 'vn_stat',   col: 'pdx',         type: 'icd10', label: 'วินิจฉัยหลัก (Pdx)' },
  cc:          { table: 'opdscreen', col: 'cc',          type: 'text',  label: 'อาการสำคัญ (CC)' },
  bps:         { table: 'opdscreen', col: 'bps',         type: 'int',   label: 'SBP' },
  bpd:         { table: 'opdscreen', col: 'bpd',         type: 'int',   label: 'DBP' },
  temperature: { table: 'opdscreen', col: 'temperature', type: 'float', label: 'อุณหภูมิ' },
  bw:          { table: 'opdscreen', col: 'bw',          type: 'float', label: 'น้ำหนัก' },
  height:      { table: 'opdscreen', col: 'height',      type: 'float', label: 'ส่วนสูง' },
  bmi:         { table: 'opdscreen', col: 'bmi',         type: 'float', label: 'BMI' }
};
const CHECK_KEYS = Object.keys(CHECK_FIELDS);
const CHECK_META = CHECK_KEYS.map((k) => ({ key: k, label: CHECK_FIELDS[k].label, type: CHECK_FIELDS[k].type }));
const NUMERIC_KEYS = new Set(['bps', 'bpd', 'temperature', 'bw', 'height', 'bmi']);

/** ฟิลด์ที่แก้ไขได้เพิ่มเติม (ไม่นับรวมในเปอร์เซ็นต์ความสมบูรณ์ 9 ช่อง) */
const EXTRA_FIELDS = {
  doctor: { table: 'ovst', col: 'doctor', type: 'text', label: 'แพทย์' }
};
const ALL_FIELDS = Object.assign({}, CHECK_FIELDS, EXTRA_FIELDS);

/** ช่องนี้ถือว่า "ว่าง" หรือไม่ (ตัวเลขวัดค่า 0 = ยังไม่วัด = ว่าง) */
function isBlank(key, v) {
  if (v === null || v === undefined || String(v).trim() === '') return true;
  if (NUMERIC_KEYS.has(key) && Number(v) === 0) return true;
  return false;
}

/** ส่วน SELECT ... FROM ... (ทุก join) ตามคิวรี่ที่กำหนด — {{CAST}} แทนชนิดตาม dialect */
const CHECK_SELECT = [
  "SELECT o.oqueue, o.vstdate, o.vsttime, o.hn, o.main_dep,",
  "  COALESCE(kk3.department, CONCAT('จุดบริการ ', o.main_dep)) AS dep_name,",
  "  CAST(CONCAT(COALESCE(p.pname,''), COALESCE(p.fname,''), ' ', COALESCE(p.lname,'')) AS {{CAST}}) AS ptname,",
  "  t.name AS pttype_name, t.hipdata_code,",
  "  v.hospmain, o.pttypeno, v.pdx, i.name AS pdx_name,",
  "  sti.name AS ovstist_name, st.name AS ost_name,",
  "  (SELECT od1.doctor FROM ovstdiag od1 WHERE od1.vn = o.vn AND od1.diagtype = '1' LIMIT 1) AS doctor_code,",
  "  (SELECT dcx.name FROM ovstdiag od2 JOIN doctor dcx ON dcx.code = od2.doctor WHERE od2.vn = o.vn AND od2.diagtype = '1' LIMIT 1) AS doctor_name,",
  "  vt.visit_type_name,",
  "  CAST(oc.cc AS {{CAST}}) AS cc,",
  "  oc.bps, oc.bpd, oc.temperature, oc.bw, oc.height, oc.bmi,",
  "{{APPSTAFF}}  o.vn",
  "FROM ovst o",
  "  LEFT OUTER JOIN vn_stat v ON v.vn = o.vn",
  "  LEFT OUTER JOIN opdscreen oc ON oc.vn = o.vn",
  "  LEFT OUTER JOIN patient p ON p.hn = o.hn",
  "  LEFT OUTER JOIN pttype t ON t.pttype = o.pttype",
  "  LEFT OUTER JOIN icd101 i ON i.code = v.pdx",
  "  LEFT OUTER JOIN ovstist sti ON sti.ovstist = o.ovstist",
  "  LEFT OUTER JOIN ovstost st ON st.ovstost = o.ovstost",
  "  LEFT OUTER JOIN kskdepartment kk3 ON kk3.depcode = o.main_dep",
  "  LEFT OUTER JOIN visit_type vt ON vt.visit_type = o.visit_type"
].join('\n');

function checkSelect(cfg, hasAppStaff) {
  const castT = cfg.driver === 'postgres' ? 'VARCHAR(250)' : 'CHAR(250)';
  // คอลัมน์ "ผู้บันทึกเพิ่มเติม": ovst.app_staff → officer.officer_login_name → officer.officer_name
  const appStaff = hasAppStaff
    ? "  o.app_staff,\n  (SELECT ofc.officer_name FROM officer ofc WHERE ofc.officer_login_name = o.app_staff LIMIT 1) AS app_staff_name,\n"
    : "  CAST(NULL AS " + castT + ") AS app_staff, CAST(NULL AS " + castT + ") AS app_staff_name,\n";
  return CHECK_SELECT.replace(/\{\{CAST\}\}/g, castT).replace('{{APPSTAFF}}', appStaff);
}

/** ovst.app_staff มีอยู่จริงหรือยัง (แคชผล 5 นาที) — กันพังหากยังไม่ได้เพิ่มคอลัมน์ */
let _appStaffCol = { val: null, at: 0 };
async function appStaffAvailable(cfg) {
  const now = Date.now();
  if (_appStaffCol.val !== null && (now - _appStaffCol.at) < 300000) return _appStaffCol.val;
  try {
    const r = await db.query(cfg,
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'ovst' AND column_name = 'app_staff' LIMIT 1");
    _appStaffCol = { val: r.length > 0, at: now };
  } catch (e) { _appStaffCol = { val: false, at: now }; }
  return _appStaffCol.val;
}

/** ประทับชื่อผู้บันทึกเพิ่มเติม (login) ลง ovst.app_staff — ปลอดภัย เป็น no-op ถ้ายังไม่มีคอลัมน์ */
async function stampAppStaff(cfg, vn, login) {
  if (!vn || !login) return;
  if (!(await appStaffAvailable(cfg))) return;
  try { await db.execute(cfg, 'UPDATE ovst SET app_staff = ? WHERE vn = ?', [String(login).slice(0, 150), String(vn)]); }
  catch (e) { /* เงียบ ไม่ให้กระทบการบันทึกหลัก */ }
}

/** รพ.หลัก ตรวจเฉพาะสิทธิที่ต้องระบุหน่วยบริการหลัก */
const HOSPMAIN_RIGHTS = new Set(['SSS', 'UCS', 'WEL']);
function hospmainRequired(row) {
  return HOSPMAIN_RIGHTS.has(String(row.hipdata_code || '').trim().toUpperCase());
}

/** ประเมินความครบของฟิลด์ที่ตรวจ */
function evalCheck(row) {
  const missing = [];
  for (const k of CHECK_KEYS) {
    if (k === 'hospmain') {
      // ตรวจ รพ.หลัก เฉพาะเมื่อ pttype.hipdata_code ∈ (SSS, UCS, WEL)
      if (hospmainRequired(row) && isBlank(k, row[k])) missing.push(k);
      continue;
    }
    if (isBlank(k, row[k])) missing.push(k);
  }
  const score = CHECK_KEYS.length - missing.length;
  return {
    missing, score, total: CHECK_KEYS.length,
    percent: Math.round((score / CHECK_KEYS.length) * 100),
    complete: missing.length === 0
  };
}

function decorateCheck(r) {
  const ev = evalCheck(r);
  return Object.assign({}, r, {
    vstdate: String(r.vstdate).slice(0, 10),
    vsttime: String(r.vsttime || '').slice(0, 8),
    app_staff: r.app_staff || '',
    app_staff_name: r.app_staff_name || '',
    _missing: ev.missing, _score: ev.score, _percent: ev.percent, _complete: ev.complete
  });
}

/** ดึงรายการตรวจสอบตามช่วงวันที่ + จุดบริการ (เฉพาะ OPD: an is null) */
async function checkList(cfg, from, to, depCode, limit) {
  const has = await appStaffAvailable(cfg);
  let sql = checkSelect(cfg, has) + '\n WHERE o.vstdate BETWEEN {{D}} AND {{D}} AND o.an is null';
  const params = [from, to];
  if (depCode) { sql += ' AND o.main_dep = ?'; params.push(depCode); }
  sql += ' ORDER BY o.vn';
  sql += ' LIMIT ' + Math.min(parseInt(limit, 10) || 5000, 20000);
  const rows = await db.query(cfg, sqlFor(cfg, sql), params);
  return rows.map(decorateCheck);
}

/** อ่านแถวเดียว (หลังบันทึก เพื่อส่งค่าล่าสุดกลับ) */
async function getCheckRow(cfg, vn) {
  const has = await appStaffAvailable(cfg);
  const sql = checkSelect(cfg, has) + '\n WHERE o.vn = ? LIMIT 1';
  const rows = await db.query(cfg, sql, [vn]);
  return rows.length ? decorateCheck(rows[0]) : null;
}

/** สรุปสำหรับส่วนหัวหน้าตรวจสอบ + แดชบอร์ด (รายจุดบริการ/รายฟิลด์) */
function summarizeCheck(rows) {
  const miss = {};
  CHECK_KEYS.forEach((k) => { miss[k] = 0; });
  const byDep = new Map();
  let complete = 0, scoreSum = 0;

  for (const r of rows) {
    if (r._complete) complete++;
    scoreSum += r._score;
    for (const m of r._missing) miss[m]++;
    const code = r.main_dep === null || r.main_dep === undefined ? '' : String(r.main_dep);
    if (!byDep.has(code)) byDep.set(code, { dep_code: code, dep_name: r.dep_name || ('จุดบริการ ' + code), total: 0, complete: 0, scoreSum: 0 });
    const d = byDep.get(code);
    d.total++; d.scoreSum += r._score;
    if (r._complete) d.complete++;
  }

  const N = CHECK_KEYS.length;
  const deps = [...byDep.values()].map((d) => ({
    dep_code: d.dep_code, dep_name: d.dep_name, total: d.total, complete: d.complete,
    incomplete: d.total - d.complete,
    percent: d.total ? Math.round((d.scoreSum / (d.total * N)) * 100) : 0
  })).sort((a, b) => b.total - a.total);

  const fields = CHECK_META.map((f) => ({
    key: f.key, label: f.label, missing: miss[f.key],
    filled: rows.length - miss[f.key],
    percent: rows.length ? Math.round(((rows.length - miss[f.key]) / rows.length) * 100) : 0
  })).sort((a, b) => b.missing - a.missing);

  return {
    total: rows.length, complete, incomplete: rows.length - complete,
    percent: rows.length ? Math.round((scoreSum / (rows.length * N)) * 100) : 0,
    deps, fields
  };
}

/** บันทึกค่า 1 ช่อง กลับเข้าฟิลด์เดิมทันที */
async function saveCheckField(cfg, field, vn, value) {
  const f = ALL_FIELDS[field];
  if (!f) { const e = new Error('ฟิลด์นี้ไม่อนุญาตให้แก้ไข'); e.status = 400; throw e; }
  vn = String(vn || '');
  if (!vn) { const e = new Error('ไม่พบ VN'); e.status = 400; throw e; }

  const raw = value === undefined || value === null ? '' : String(value).trim();

  // แพทย์: บันทึกกลับ ovstdiag.doctor เฉพาะการวินิจฉัยหลัก (diagtype='1')
  if (field === 'doctor') {
    if (!raw) { const e = new Error('กรุณาเลือกแพทย์'); e.status = 400; throw e; }
    const r = await db.execute(cfg, "UPDATE ovstdiag SET doctor = ? WHERE vn = ? AND diagtype = '1'", [raw, vn]);
    if (!r.affected) {
      const e = new Error('ยังไม่มีการวินิจฉัยหลัก (Pdx) ของ visit นี้ จึงบันทึกแพทย์ไม่ได้ — กรุณาระบุ Pdx ก่อน');
      e.status = 400; throw e;
    }
    return { affected: r.affected, value: raw };
  }

  let val;
  if (f.type === 'int') {
    if (raw === '') { const e = new Error('กรุณากรอกตัวเลข'); e.status = 400; throw e; }
    val = parseInt(raw, 10);
    if (isNaN(val)) { const e = new Error('ค่าต้องเป็นจำนวนเต็ม'); e.status = 400; throw e; }
  } else if (f.type === 'float') {
    if (raw === '') { const e = new Error('กรุณากรอกตัวเลข'); e.status = 400; throw e; }
    val = Number(raw);
    if (isNaN(val)) { const e = new Error('ค่าต้องเป็นตัวเลข'); e.status = 400; throw e; }
  } else if (f.type === 'icd10') {
    val = raw.toUpperCase();
    if (!val) { const e = new Error('กรุณาระบุรหัส ICD-10'); e.status = 400; throw e; }
  } else {
    val = raw;
  }

  // opdscreen อาจยังไม่มีแถว → สร้างใหม่ก่อน
  if (f.table === 'opdscreen') {
    const ex = await db.query(cfg, 'SELECT vn FROM opdscreen WHERE vn = ? LIMIT 1', [vn]);
    if (!ex.length) {
      const ov = await db.query(cfg, 'SELECT hn, vstdate, vsttime FROM ovst WHERE vn = ? LIMIT 1', [vn]);
      if (!ov.length) { const e = new Error('ไม่พบ visit นี้'); e.status = 404; throw e; }
      const sql = 'INSERT INTO opdscreen (vn, hn, vstdate, vsttime, ' + f.col + ') VALUES (?, ?, ?, ?, ?)';
      await db.execute(cfg, sql, [vn, ov[0].hn, String(ov[0].vstdate).slice(0, 10), ov[0].vsttime || '00:00:00', val]);
      return { affected: 1, value: val };
    }
  }

  const r = await db.execute(cfg, 'UPDATE ' + f.table + ' SET ' + f.col + ' = ? WHERE vn = ?', [val, vn]);
  if (!r.affected && f.table === 'vn_stat') {
    const e = new Error('ไม่พบระเบียน vn_stat ของ visit นี้ (ยังไม่ได้ประมวลผลสถิติ)');
    e.status = 404; throw e;
  }
  return { affected: r.affected, value: val };
}

module.exports = {
  RULES, RULE_META, evaluate, departments, visits, getVisit, summarize,
  lookup, searchIcd10, diagsOf, saveScreen, saveVisitFields, addDiag, sqlFor,
  CHECK_FIELDS, CHECK_META, CHECK_KEYS, checkList, getCheckRow, summarizeCheck, saveCheckField, evalCheck,
  searchDoctors, diagsFull, getVisitDoctor, addDiagVn, updateDiagType, updateDiagDoctor, deleteDiag,
  stampAppStaff, appStaffAvailable
};
