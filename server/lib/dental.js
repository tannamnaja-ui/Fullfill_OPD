'use strict';
/** ตรวจสอบความสมบูรณ์ข้อมูลทันตกรรม (ตาราง dental_care — แฟ้ม DENTAL) */
const db = require('./db');

const FK = 'fk', INT = 'int', CHK = 'chk', TXT = 'text';

/** ฟิลด์ที่ต้องบันทึก (ควรบันทึก = Y) พร้อมตาราง/คอลัมน์จริงใน dental_care */
const FIELDS = [
  { key: 'denttype',        col: 'dental_care_type_id',                 type: FK,  lookup: 'type',        label: 'ประเภทผู้รับบริการ', w: 170 },
  { key: 'servplace',       col: 'dental_care_service_place_type_id',   type: FK,  lookup: 'place',       label: 'ใน/นอกหน่วยบริการ', w: 150 },
  { key: 'pteeth',          col: 'pteeth',                              type: INT, label: 'ฟันแท้ที่มี', w: 90 },
  { key: 'pcaries',         col: 'pcaries',                             type: INT, label: 'ฟันแท้ผุไม่ได้อุด', w: 110 },
  { key: 'pfilling',        col: 'pfilling',                            type: INT, label: 'ฟันแท้ได้อุด', w: 100 },
  { key: 'pextract',        col: 'pextract',                            type: INT, label: 'ฟันแท้ถอน/หลุด', w: 110 },
  { key: 'dteeth',          col: 'dteeth',                              type: INT, label: 'ฟันน้ำนมที่มี', w: 100 },
  { key: 'dcaries',         col: 'dcaries',                             type: INT, label: 'ฟันน้ำนมผุไม่ได้อุด', w: 120 },
  { key: 'dfilling',        col: 'dfilling',                            type: INT, label: 'ฟันน้ำนมได้อุด', w: 110 },
  { key: 'dextract',        col: 'dextract',                            type: INT, label: 'ฟันน้ำนมถอน', w: 100 },
  { key: 'need_fluoride',   col: 'need_fluoride',                       type: CHK, label: 'ต้องทาฟลูออไรด์', w: 110 },
  { key: 'need_scaling',    col: 'need_scaling',                        type: CHK, label: 'ต้องขูดหินน้ำลาย', w: 110 },
  { key: 'need_sealant',    col: 'need_sealant',                        type: INT, label: 'ต้องเคลือบหลุมร่องฟัน', w: 120 },
  { key: 'need_pfilling',   col: 'need_pfilling',                       type: INT, label: 'ฟันแท้ที่ต้องอุด', w: 110 },
  { key: 'need_dfilling',   col: 'need_dfilling',                       type: INT, label: 'ฟันน้ำนมที่ต้องอุด', w: 120 },
  { key: 'need_pextract',   col: 'need_pextract',                       type: INT, label: 'ฟันแท้ต้องถอน/รักษาราก', w: 130 },
  { key: 'need_dextract',   col: 'need_dextract',                       type: INT, label: 'ฟันน้ำนมต้องถอน/รักษาราก', w: 140 },
  { key: 'nprosthesis',     col: 'dental_care_nprosthesis_id',          type: FK,  lookup: 'nprosthesis', label: 'จำเป็นต้องใส่ฟันเทียม', w: 160 },
  { key: 'permanent_perma', col: 'permanent_perma',                     type: INT, label: 'คู่สบ ฟันแท้-ฟันแท้', w: 120 },
  { key: 'permanent_prost', col: 'permanent_prost',                     type: INT, label: 'คู่สบ ฟันแท้-ฟันเทียม', w: 130 },
  { key: 'prosthesis_prost',col: 'prosthesis_prost',                    type: INT, label: 'คู่สบ ฟันเทียม-ฟันเทียม', w: 140 },
  { key: 'gum',             col: 'dental_care_gum_type_id',             type: FK,  lookup: 'gum',         label: 'สภาวะปริทันต์', w: 150 },
  { key: 'schooltype',      col: 'dental_care_school_type_id',          type: FK,  lookup: 'school',      label: 'สถานศึกษา', w: 160 },
  { key: 'schoolclass',     col: 'dental_care_school_class_type_id',    type: FK,  lookup: 'schoolclass', label: 'ระดับการศึกษา', w: 150 },
  { key: 'provider',        col: 'doctor',                              type: TXT, label: 'ผู้ให้บริการ', w: 150, ro: true, nameKey: 'provider_name' }
];
const BY_KEY = {};
FIELDS.forEach((f) => { BY_KEY[f.key] = f; });
const META = FIELDS.map((f) => ({ key: f.key, label: f.label, type: f.type, lookup: f.lookup || null, w: f.w, ro: !!f.ro, nameKey: f.nameKey || null }));

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

/** ประเมินความครบของฟิลด์ทันตกรรม (ว่าง/null = ยังไม่ครบ; 0 = ถือว่ามีข้อมูล) */
function evalDental(row) {
  const missing = FIELDS.filter((f) => isBlank(row[f.key])).map((f) => f.key);
  const score = FIELDS.length - missing.length;
  return { missing, score, total: FIELDS.length, percent: Math.round((score / FIELDS.length) * 100), complete: missing.length === 0 };
}

/* ---------------- Query ---------------- */
const SELECT = [
  "SELECT o.vn, oq.seq_id AS seq, o.hn, o.vstdate, o.main_dep,",
  "  (SELECT COUNT(*) FROM dtmain d2 WHERE d2.vn = o.vn) AS reccount,",
  "  COALESCE(kk.department, CONCAT('จุดบริการ ', o.main_dep)) AS dep_name,",
  "  CAST(CONCAT(COALESCE(p.pname,''), COALESCE(p.fname,''), ' ', COALESCE(p.lname,'')) AS {{CAST}}) AS ptname,",
  "  p.cid AS cid,",
  "  dc.dental_care_type_id AS denttype, dc.dental_care_service_place_type_id AS servplace,",
  "  dc.pteeth, dc.pcaries, dc.pfilling, dc.pextract,",
  "  dc.dteeth, dc.dcaries, dc.dfilling, dc.dextract,",
  "  dc.need_fluoride, dc.need_scaling, dc.need_sealant,",
  "  dc.need_pfilling, dc.need_dfilling, dc.need_pextract, dc.need_dextract,",
  "  dc.dental_care_nprosthesis_id AS nprosthesis, dc.permanent_perma, dc.permanent_prost, dc.prosthesis_prost,",
  "  dc.dental_care_gum_type_id AS gum, dc.dental_care_school_type_id AS schooltype,",
  "  dc.dental_care_school_class_type_id AS schoolclass, dc.doctor AS provider,",
  "  (SELECT dcx.name FROM doctor dcx WHERE dcx.code = dc.doctor LIMIT 1) AS provider_name",
  "FROM ovst o",
  "  JOIN (SELECT DISTINCT vn FROM dtmain) dm ON dm.vn = o.vn",
  "  LEFT JOIN dental_care dc ON dc.vn = o.vn",
  "  LEFT JOIN ovst_seq oq ON oq.vn = o.vn",
  "  LEFT JOIN patient p ON p.hn = o.hn",
  "  LEFT JOIN kskdepartment kk ON kk.depcode = o.main_dep"
].join('\n');

function selectFor(cfg) {
  return SELECT.replace(/\{\{CAST\}\}/g, cfg.driver === 'postgres' ? 'VARCHAR(250)' : 'CHAR(250)');
}
const dateHolder = (cfg) => (cfg.driver === 'postgres' ? '?::date' : '?');

function decorate(r) {
  const ev = evalDental(r);
  return Object.assign({}, r, {
    vstdate: db.ymd(r.vstdate),
    ptname: r.ptname || '',
    _missing: ev.missing, _score: ev.score, _percent: ev.percent, _complete: ev.complete
  });
}

/** รายการทันตกรรมตามช่วงวันที่ + จุดบริการ */
async function dentalList(cfg, from, to, depCode, limit) {
  const D = dateHolder(cfg);
  let sql = selectFor(cfg) + '\n WHERE o.vstdate BETWEEN ' + D + ' AND ' + D;
  const params = [from, to];
  if (depCode) { sql += ' AND o.main_dep = ?'; params.push(depCode); }
  sql += ' ORDER BY o.vn';
  sql += ' LIMIT ' + Math.min(parseInt(limit, 10) || 5000, 20000);
  const rows = await db.query(cfg, sql, params);
  return rows.map(decorate);
}

async function getDentalRow(cfg, vn) {
  const rows = await db.query(cfg, selectFor(cfg) + '\n WHERE o.vn = ? LIMIT 1', [vn]);
  return rows.length ? decorate(rows[0]) : null;
}

/** สรุปสำหรับส่วนหัว/แดชบอร์ด */
function summarizeDental(rows) {
  const miss = {};
  FIELDS.forEach((f) => { miss[f.key] = 0; });
  let complete = 0, scoreSum = 0;
  for (const r of rows) {
    if (r._complete) complete++;
    scoreSum += r._score;
    for (const m of r._missing) miss[m]++;
  }
  return {
    total: rows.length, complete, incomplete: rows.length - complete,
    percent: rows.length ? Math.round((scoreSum / (rows.length * FIELDS.length)) * 100) : 0,
    fields: META.map((f) => ({ key: f.key, label: f.label, missing: miss[f.key] })).sort((a, b) => b.missing - a.missing)
  };
}

/* ---------------- Lookups (FK) ---------------- */
const LOOKUP_TABLES = {
  type:        { table: 'dental_care_type',                pk: 'dental_care_type_id' },
  place:       { table: 'dental_care_service_place_type',  pk: 'dental_care_service_place_type_id' },
  nprosthesis: { table: 'dental_care_nprosthesis',         pk: 'dental_care_nprosthesis_id' },
  gum:         { table: 'dental_care_gum_type',            pk: 'dental_care_gum_type_id' },
  school:      { table: 'dental_care_school_type',         pk: 'dental_care_school_type_id' },
  schoolclass: { table: 'dental_care_school_class_type',   pk: 'dental_care_school_class_type_id' }
};

async function dentalLookups(cfg) {
  const out = {};
  for (const key of Object.keys(LOOKUP_TABLES)) {
    const t = LOOKUP_TABLES[key];
    // คอลัมน์ชื่อใน HOSxP XE = <ชื่อตาราง>_name (ไม่ใช่ name เฉย ๆ)
    const nameCol = t.table + '_name';
    try {
      const rows = await db.query(cfg, 'SELECT ' + t.pk + ' AS code, ' + nameCol + ' AS name FROM ' + t.table + ' ORDER BY ' + t.pk, []);
      out[key] = rows.map((r) => ({ code: String(r.code === null ? '' : r.code), name: r.name || '' }));
    } catch (e) { out[key] = []; }
  }
  return out;
}

/* ---------------- Save ---------------- */
async function saveDentalField(cfg, field, vn, value) {
  const f = BY_KEY[field];
  if (!f) { const e = new Error('ฟิลด์นี้ไม่อนุญาตให้แก้ไข'); e.status = 400; throw e; }
  vn = String(vn || '');
  if (!vn) { const e = new Error('ไม่พบ VN'); e.status = 400; throw e; }
  const raw = value === undefined || value === null ? '' : String(value).trim();

  let val;
  if (f.type === INT || f.type === FK) {
    if (raw === '') { const e = new Error('กรุณากรอกค่า'); e.status = 400; throw e; }
    val = parseInt(raw, 10);
    if (isNaN(val)) { const e = new Error('ค่าต้องเป็นตัวเลข'); e.status = 400; throw e; }
  } else if (f.type === CHK) {
    val = (raw === '1' || raw.toLowerCase() === 'true' || raw === 'Y') ? 1 : 0;
  } else {
    if (raw === '') { const e = new Error('กรุณากรอกค่า'); e.status = 400; throw e; }
    val = raw;
  }

  const r = await db.execute(cfg, 'UPDATE dental_care SET ' + f.col + ' = ? WHERE vn = ?', [val, vn]);
  if (!r.affected) { const e = new Error('ไม่พบระเบียนทันตกรรมของ visit นี้'); e.status = 404; throw e; }
  return { affected: r.affected, value: val };
}

/* ---------------- เติมค่าเริ่มต้นให้ช่องที่ขาด (ตาม vn ที่เลือก) ---------------- */
// mode: 'null' = เติมเมื่อ NULL ; 'nullneg' = เติมเมื่อ NULL หรือ < 0
const FILLS = [
  { col: 'dental_care_type_id', val: 1, mode: 'null' },                 // ประเภทผู้รับบริการ
  { col: 'dental_care_service_place_type_id', val: 1, mode: 'null' },   // ใน/นอกหน่วยบริการ
  { col: 'dental_care_nprosthesis_id', val: 4, mode: 'null' },          // จำเป็นใส่ฟันเทียม
  { col: 'dental_care_gum_type_id', val: 9, mode: 'null' },             // สภาวะปริทันต์ (ช่องรวม)
  { col: 'dental_care_school_type_id', val: 1, mode: 'null' },          // สถานศึกษา
  { col: 'dental_care_school_class_type_id', val: 1, mode: 'null' },    // ระดับการศึกษา
  { col: 'need_fluoride', val: 2, mode: 'null' },                       // ต้องทาฟลูออไรด์
  { col: 'need_scaling', val: 2, mode: 'null' },                        // ต้องขูดหินน้ำลาย
  { col: 'pteeth', val: 0, mode: 'nullneg' },
  { col: 'pcaries', val: 0, mode: 'nullneg' },
  { col: 'pfilling', val: 0, mode: 'nullneg' },
  { col: 'pextract', val: 0, mode: 'nullneg' },
  { col: 'dteeth', val: 0, mode: 'nullneg' },
  { col: 'dcaries', val: 0, mode: 'nullneg' },
  { col: 'dfilling', val: 0, mode: 'nullneg' },
  { col: 'dextract', val: 0, mode: 'nullneg' },
  { col: 'need_sealant', val: 0, mode: 'nullneg' },
  { col: 'need_pextract', val: 0, mode: 'nullneg' },
  { col: 'need_dextract', val: 0, mode: 'nullneg' },
  { col: 'permanent_perma', val: 0, mode: 'nullneg' },
  { col: 'permanent_prost', val: 0, mode: 'nullneg' },
  { col: 'prosthesis_prost', val: 0, mode: 'nullneg' },
  { col: 'dental_care_gum_type_id_1', val: 9, mode: 'null' },
  { col: 'dental_care_gum_type_id_2', val: 9, mode: 'null' },
  { col: 'dental_care_gum_type_id_3', val: 9, mode: 'null' },
  { col: 'dental_care_gum_type_id_4', val: 9, mode: 'null' },
  { col: 'dental_care_gum_type_id_5', val: 9, mode: 'null' },
  { col: 'dental_care_gum_type_id_6', val: 9, mode: 'null' },
  { col: 'need_pfilling', val: 0, mode: 'nullneg' },
  { col: 'need_dfilling', val: 0, mode: 'nullneg' }
];

/** เติมค่าเริ่มต้นให้ช่องที่ขาด เฉพาะ vn ที่ระบุ (ไม่สนวันที่) */
async function fillDentalDefaults(cfg, vns) {
  const list = (vns || []).map((v) => String(v)).filter(Boolean);
  if (!list.length) { const e = new Error('ไม่ได้เลือกรายการ'); e.status = 400; throw e; }
  const inMarks = list.map(() => '?').join(',');

  // 0) สร้างแถว dental_care ให้ vn ที่ยังไม่มี (ไม่งั้น UPDATE จะไม่เจอแถว)
  let created = 0;
  let createFail = 0;
  const have = new Set();
  try {
    const ex = await db.query(cfg, 'SELECT vn FROM dental_care WHERE vn IN (' + inMarks + ')', list);
    ex.forEach((r) => have.add(String(r.vn)));
  } catch (e) { /* ถ้าอ่านไม่ได้ ปล่อยให้ UPDATE ทำงานตามปกติ */ }
  // คอลัมน์ NOT NULL ที่ต้องออกเลขด้วย get_serialnumber ตอนสร้างระเบียนใหม่
  const SERIAL_COLS = ['dental_care_id', 'dental_care_type_id'];
  const insCols = SERIAL_COLS.concat(['vn']);
  const insVals = SERIAL_COLS.map((c) => "get_serialnumber('" + c + "')").concat(['?']);
  const insSql = 'INSERT INTO dental_care (' + insCols.join(', ') + ') VALUES (' + insVals.join(', ') + ')';

  const missing = list.filter((v) => !have.has(String(v)));
  let createErr = '';
  for (const vn of missing) {
    try {
      await db.execute(cfg, insSql, [vn]);
      created++;
    } catch (e) { createFail++; if (!createErr) createErr = (e && e.message) ? e.message : String(e); }
  }
  // อัพเดทเลขล่าสุดกลับตาราง serial ให้ตรงกับค่าสูงสุดที่ใช้ไป (ทุกคอลัมน์ที่ seed)
  if (created > 0) {
    for (const c of SERIAL_COLS) {
      try {
        await db.execute(cfg,
          'UPDATE serial SET serial_no = (SELECT MAX(' + c + ') FROM dental_care) WHERE name = ' + "'" + c + "'", []);
      } catch (e) { if (!createErr) createErr = 'serial(' + c + '): ' + ((e && e.message) ? e.message : String(e)); }
    }
  }

  let affected = 0;
  const byCol = {};
  const skipped = [];
  for (const f of FILLS) {
    const cond = f.mode === 'null'
      ? (f.col + ' IS NULL')
      : ('(' + f.col + ' IS NULL OR ' + f.col + ' < 0)');
    const sql = 'UPDATE dental_care SET ' + f.col + ' = ? WHERE vn IN (' + inMarks + ') AND ' + cond;
    try {
      const r = await db.execute(cfg, sql, [f.val].concat(list));
      affected += r.affected || 0;
      byCol[f.col] = r.affected || 0;
    } catch (e) { skipped.push(f.col); }
  }

  // ผู้ให้บริการ: นำ dtmain.doctor มาใส่ (เฉพาะที่ยังว่าง)
  try {
    const docSql = 'UPDATE dental_care SET doctor = ' +
      "(SELECT dm.doctor FROM dtmain dm WHERE dm.vn = dental_care.vn AND dm.doctor IS NOT NULL AND dm.doctor <> '' LIMIT 1) " +
      'WHERE vn IN (' + inMarks + ") AND (doctor IS NULL OR doctor = '')";
    const r = await db.execute(cfg, docSql, list);
    affected += r.affected || 0;
    byCol.doctor = r.affected || 0;
  } catch (e) { skipped.push('doctor'); }

  return { affected, byCol, skipped, vnCount: list.length, created, createFail, createErr };
}

module.exports = { FIELDS, META, evalDental, dentalList, getDentalRow, summarizeDental, dentalLookups, saveDentalField, fillDentalDefaults };
