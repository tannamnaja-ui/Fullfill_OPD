'use strict';
/** ตรวจสอบ/เพิ่มข้อมูลงานกายภาพบำบัด-ฟื้นฟู (แฟ้ม REHABILITATION) — รวม OPD + IPD
 *  รายบริการ OPD/IPD: physic_plan_detail (คีย์ physic_plan_detail_id, src='D')
 *  รายบริการ IPD:     physic_plan_ipd_detail (คีย์ physic_plan_ipd_detail_id, src='I')
 *  ทะเบียน/แผน: physic_plan (physic_plan_id) → physic_register (วันเริ่ม/จำหน่าย, depcode)
 *  REHABCODE: physic_items.f43_rehab_code */
const db = require('./db');

const TXT = 'text', INT = 'int', RO = 'ro', RODATE = 'rodate', DATE = 'date';

const FIELDS = [
  { key: 'item_name',   label: 'รายการบริการ',    type: RO,   w: 200, check: false },
  { key: 'rehabcode',   label: 'REHAB code (43)', type: TXT,  w: 120, check: true, editable: true,
    save: { table: 'physic_items',        col: 'f43_rehab_code',         key: 'items_id',    keyCol: 'physic_items_id' } },
  { key: 'rehabplace',  label: 'สถานที่บริการ',   type: TXT,  w: 110, check: true, editable: true,
    save: { table: 'physic_register',     col: 'physic_register_depcode', key: 'register_id', keyCol: 'physic_register_id' } },
  { key: 'date_start',  label: 'วันเริ่มฟื้นฟู',  type: DATE, w: 130, check: true, editable: true,
    save: { table: 'physic_register',     col: 'physic_register_date',    key: 'register_id', keyCol: 'physic_register_id' } },
  { key: 'date_finish', label: 'วันสิ้นสุด',      type: DATE, w: 130, check: true, editable: true,
    save: { table: 'physic_register',     col: 'physic_register_dch_date', key: 'register_id', keyCol: 'physic_register_id' } },
  { key: 'provider',    label: 'ผู้ให้บริการ',    type: TXT,  w: 130, check: true, editable: true, srcD: true,
    save: { table: 'physic_plan_detail',  col: 'doctor',                  key: 'pid',         keyCol: 'physic_plan_detail_id' } }
];
const BY_KEY = {};
FIELDS.forEach((f) => { BY_KEY[f.key] = f; });
const CHECK_KEYS = FIELDS.filter((f) => f.check).map((f) => f.key);
const META = FIELDS.map((f) => ({ key: f.key, label: f.label, type: f.type, w: f.w, check: f.check, editable: !!f.editable }));

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

function evalPhysio(row) {
  const missing = CHECK_KEYS.filter((k) => isBlank(row[k]));
  const score = CHECK_KEYS.length - missing.length;
  return { missing, score, total: CHECK_KEYS.length, percent: Math.round((score / CHECK_KEYS.length) * 100), complete: missing.length === 0 };
}

function toISO(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date && !isNaN(v)) return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
  const s = String(v); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const d = new Date(s); if (!isNaN(d)) return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  return s.slice(0, 10);
}

/** รายบริการรวม OPD (physic_plan_detail) + IPD (physic_plan_ipd_detail) */
const SVC = [
  "SELECT 'D' AS src, d.physic_plan_detail_id AS pid, d.physic_plan_id AS plan_id,",
  '       d.vn AS vn, d.an AS an, d.physic_items_id AS items_id, d.doctor AS provider',
  '  FROM physic_plan_detail d',
  'UNION ALL',
  "SELECT 'I' AS src, i.physic_plan_ipd_detail_id AS pid, i.physic_plan_id AS plan_id,",
  '       pl.vn AS vn, pl.an AS an, i.physic_items_id AS items_id, CAST(NULL AS VARCHAR) AS provider',
  '  FROM physic_plan_ipd_detail i JOIN physic_plan pl ON pl.physic_plan_id = i.physic_plan_id'
].join('\n');

function regCol(col) {
  return '(SELECT r.' + col + ' FROM physic_plan pp JOIN physic_register r ON r.physic_register_id = pp.physic_register_id WHERE pp.physic_plan_id = s.plan_id LIMIT 1)';
}

const SELECT = [
  'SELECT s.src, s.pid, s.plan_id, s.vn, s.an, s.provider, s.items_id AS items_id,',
  '  (SELECT pp.physic_register_id FROM physic_plan pp WHERE pp.physic_plan_id = s.plan_id LIMIT 1) AS register_id,',
  "  COALESCE(it.name,'') AS item_name, COALESCE(it.f43_rehab_code,'') AS rehabcode,",
  "  COALESCE(doc.name,'') AS provider_name,",
  '  COALESCE(o.hn, ip.hn) AS hn, o.vstdate AS opd_vstdate, o.main_dep AS main_dep,',
  "  COALESCE(kk.department,'') AS dep_name, p.cid AS cid,",
  '  ' + regCol('physic_register_depcode') + ' AS rehabplace,',
  '  ' + regCol('physic_register_date') + ' AS date_start,',
  '  ' + regCol('physic_register_dch_date') + ' AS date_finish,',
  "  CAST(CONCAT(COALESCE(p.pname,''), COALESCE(p.fname,''), ' ', COALESCE(p.lname,'')) AS {{CAST}}) AS ptname,",
  "  v.pdx AS pdx, COALESCE(i2.name,'') AS pdx_name, CAST(oc.cc AS {{CAST}}) AS cc,",
  '  oc.bps, oc.bpd, oc.temperature, oc.bw, oc.height, oc.bmi',
  '  FROM (' + SVC + ') s',
  '  LEFT JOIN physic_items it ON it.physic_items_id = s.items_id',
  '  LEFT JOIN doctor doc ON doc.code = s.provider',
  '  LEFT JOIN ovst o ON o.vn = s.vn',
  '  LEFT JOIN ipt ip ON ip.an = s.an',
  '  LEFT JOIN patient p ON p.hn = COALESCE(o.hn, ip.hn)',
  '  LEFT JOIN kskdepartment kk ON kk.depcode = o.main_dep',
  '  LEFT JOIN vn_stat v ON v.vn = s.vn',
  '  LEFT JOIN opdscreen oc ON oc.vn = s.vn',
  '  LEFT JOIN icd101 i2 ON i2.code = v.pdx'
].join('\n');

function selectFor(cfg) { return SELECT.replace(/\{\{CAST\}\}/g, cfg.driver === 'postgres' ? 'VARCHAR(250)' : 'CHAR(250)'); }
const D = (cfg) => (cfg.driver === 'postgres' ? '?::date' : '?');

function decorate(r) {
  const out = Object.assign({}, r, {
    key: r.src + ':' + r.pid,
    ptname: r.ptname || '',
    vstdate: toISO(r.opd_vstdate) || toISO(r.date_start),
    date_start: toISO(r.date_start), date_finish: toISO(r.date_finish)
  });
  const ev = evalPhysio(out);
  out._missing = ev.missing; out._score = ev.score; out._percent = ev.percent; out._complete = ev.complete;
  return out;
}

async function physioList(cfg, from, to, depCode, limit) {
  const dh = D(cfg);
  // กรองด้วยวันที่ให้บริการ: OPD ใช้ ovst.vstdate, IPD ใช้วันเริ่มฟื้นฟู (register date)
  let sql = selectFor(cfg) + '\n WHERE COALESCE(o.vstdate, ' + regCol('physic_register_date') + ') BETWEEN ' + dh + ' AND ' + dh;
  const params = [from, to];
  if (depCode) { sql += ' AND o.main_dep = ?'; params.push(depCode); }
  sql += ' ORDER BY COALESCE(o.vstdate, ' + regCol('physic_register_date') + ') DESC, s.pid';
  sql += ' LIMIT ' + Math.min(parseInt(limit, 10) || 5000, 20000);
  const rows = await db.query(cfg, sql, params);
  return rows.map(decorate);
}

async function getPhysioRow(cfg, src, pid) {
  const rows = await db.query(cfg, selectFor(cfg) + "\n WHERE s.src = ? AND s.pid = ? LIMIT 1", [src, pid]);
  return rows.length ? decorate(rows[0]) : null;
}

function summarizePhysio(rows) {
  const miss = {};
  CHECK_KEYS.forEach((k) => { miss[k] = 0; });
  let complete = 0, scoreSum = 0, ipd = 0;
  for (const r of rows) {
    if (r._complete) complete++;
    if (r.src === 'I') ipd++;
    scoreSum += r._score;
    for (const m of r._missing) miss[m]++;
  }
  return {
    total: rows.length, complete, incomplete: rows.length - complete, ipd, opd: rows.length - ipd,
    percent: rows.length ? Math.round((scoreSum / (rows.length * CHECK_KEYS.length)) * 100) : 0,
    fields: FIELDS.filter((f) => f.check).map((f) => ({ key: f.key, label: f.label, missing: miss[f.key] })).sort((a, b) => b.missing - a.missing)
  };
}

/** บันทึกกลับฟิลด์ต้นทางตามชนิดของช่อง (ctx = {src,pid,items_id,register_id,hn}) */
async function savePhysioField(cfg, field, ctx, value) {
  ctx = ctx || {};
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (raw === '') { const e = new Error('กรุณากรอกค่า'); e.status = 400; throw e; }

  // CID → patient.cid (คีย์ hn)
  if (field === 'cid') {
    if (!ctx.hn) { const e = new Error('ไม่พบ HN'); e.status = 400; throw e; }
    const r = await db.execute(cfg, 'UPDATE patient SET cid = ? WHERE hn = ?', [raw, String(ctx.hn)]);
    if (!r.affected) { const e = new Error('ไม่พบผู้ป่วย (HN นี้)'); e.status = 404; throw e; }
    return { affected: r.affected, value: raw };
  }

  const f = BY_KEY[field];
  if (!f || !f.editable || !f.save) { const e = new Error('ฟิลด์นี้แก้ไขไม่ได้'); e.status = 400; throw e; }
  if (f.srcD && String(ctx.src) !== 'D') { const e = new Error('รายการ IPD นี้แก้ไขผู้ให้บริการที่นี่ไม่ได้'); e.status = 400; throw e; }

  let val = raw;
  if (f.type === DATE && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) { const e = new Error('รูปแบบวันที่ต้องเป็น YYYY-MM-DD'); e.status = 400; throw e; }

  const keyVal = f.save.key === 'pid' ? ctx.pid : ctx[f.save.key];
  if (!keyVal) { const e = new Error('ไม่พบคีย์ของระเบียนต้นทาง (' + f.save.key + ')'); e.status = 400; throw e; }
  const r = await db.execute(cfg, 'UPDATE ' + f.save.table + ' SET ' + f.save.col + ' = ? WHERE ' + f.save.keyCol + ' = ?', [val, keyVal]);
  if (!r.affected) { const e = new Error('ไม่พบระเบียนต้นทาง (' + f.save.table + ')'); e.status = 404; throw e; }
  return { affected: r.affected, value: val };
}

/**
 * รวม REHAB code (43) ที่ซ้ำภายใน vn เดียว → เหลือเรคคอร์ดเดียว + บวกจำนวน (qty)
 * - pairs: [{vn, code}] รวมเฉพาะกลุ่มที่เลือก (คอนเซปเดียวกับป็อปอัพเลือกราย)
 * - vns:  [vn] (โหมดเดิม) รวมทุกกลุ่มที่ซ้ำใน vn นั้น
 */
async function mergeDupRehab(cfg, vns, pairs) {
  const usePairs = Array.isArray(pairs) && pairs.length > 0;
  const pairSet = usePairs ? new Set(pairs.map((p) => String(p.vn) + '|' + String(p.code))) : null;
  const list = usePairs
    ? [...new Set(pairs.map((p) => String(p.vn)).filter(Boolean))]
    : [...new Set((vns || []).map((v) => String(v)).filter(Boolean))];
  if (!list.length) { const e = new Error('ไม่ได้เลือกรายการ'); e.status = 400; throw e; }
  let groups = 0, merged = 0;
  for (const vn of list) {
    let rows;
    try {
      rows = await db.query(cfg,
        "SELECT d.physic_plan_detail_id AS id, COALESCE(d.physic_plan_detail_qty,0) AS qty, COALESCE(it.f43_rehab_code,'') AS code " +
        'FROM physic_plan_detail d LEFT JOIN physic_items it ON it.physic_items_id = d.physic_items_id ' +
        'WHERE d.vn = ? ORDER BY d.physic_plan_detail_id', [vn]);
    } catch (e) { continue; }
    const byCode = {};
    for (const r of rows) {
      const c = String(r.code).trim();
      if (!c) continue;
      (byCode[c] = byCode[c] || []).push(r);
    }
    for (const c of Object.keys(byCode)) {
      const g = byCode[c];
      if (g.length < 2) continue;
      if (pairSet && !pairSet.has(vn + '|' + c)) continue;   // เลือกเฉพาะกลุ่มที่ติ๊ก
      groups++;
      const keep = g[0].id;
      let sum = 0; g.forEach((x) => { sum += Number(x.qty) || 0; });
      await db.execute(cfg, 'UPDATE physic_plan_detail SET physic_plan_detail_qty = ? WHERE physic_plan_detail_id = ?', [sum, keep]);
      const others = g.slice(1).map((x) => x.id);
      const marks = others.map(() => '?').join(',');
      await db.execute(cfg, 'DELETE FROM physic_plan_detail WHERE physic_plan_detail_id IN (' + marks + ')', others);
      merged += others.length;
    }
  }
  return { vnCount: list.length, groups, merged };
}

/** ปรับวันที่สิ้นสุดการรักษา = วันที่เริ่มฟื้นฟู (dch_date = register_date) เฉพาะทะเบียนที่เลือกและยังว่าง */
async function fillFinishDates(cfg, registerIds) {
  const list = [...new Set((registerIds || []).map((v) => String(v)).filter(Boolean))];
  if (!list.length) { const e = new Error('ไม่ได้เลือกรายการ'); e.status = 400; throw e; }
  const marks = list.map(() => '?').join(',');
  const r = await db.execute(cfg,
    'UPDATE physic_register SET physic_register_dch_date = physic_register_date ' +
    'WHERE physic_register_id IN (' + marks + ') ' +
    'AND physic_register_dch_date IS NULL ' +
    'AND physic_register_date IS NOT NULL',
    list);
  return { requested: list.length, updated: r.affected || 0 };
}

module.exports = { FIELDS, META, evalPhysio, physioList, getPhysioRow, summarizePhysio, savePhysioField, mergeDupRehab, fillFinishDates };
