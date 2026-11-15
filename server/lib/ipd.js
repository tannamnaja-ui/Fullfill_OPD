'use strict';
/**
 * ตรวจสอบ/เพิ่มข้อมูลผู้ป่วยใน ตามแฟ้ม 43 แฟ้ม + เงื่อนไขกองทุน
 *   ADMISSION / DIAGNOSIS_IPD / DRUG_IPD / PROCEDURE_IPD / CHARGE_IPD
 * มุมมอง (basis):
 *   stay : ยังไม่จำหน่าย (นอนอยู่ใน ward) — ไม่ใช้ช่วงวันที่
 *   dch  : จำหน่ายในช่วงวันที่ (ipt.dchdate)
 *   adm  : Admit ในช่วงวันที่ (ipt.regdate)
 * SQL เขียนให้ใช้ได้ทั้ง PostgreSQL และ MySQL (โหมด BMS session) — ไม่ใช้ DISTINCT ON / ::date ตรง ๆ
 */
const db = require('./db');
const { sqlFor } = require('./opd');
const advice = require('./ipdadvice');

const TXT = 'text', INT = 'int', FLOAT = 'float', COUNT = 'count', SHOW = 'show';

const BASIS = { stay: 'ยังไม่จำหน่าย (นอนอยู่)', dch: 'จำหน่ายในช่วงวันที่', adm: 'Admit ในช่วงวันที่' };

/* ---- กองทุน (pttype.hipdata_code) ---- */
const HOSPMAIN_FUNDS = new Set(['UCS', 'SSS', 'WEL']);            // ต้องระบุหน่วยบริการหลัก
const DRG_FUNDS = new Set(['UCS', 'SSS', 'OFC', 'LGO', 'BKK']);    // จ่ายตาม DRG → ต้อง group แล้ว

const s = (v) => (v === null || v === undefined ? '' : String(v).trim());
const blank = (v) => s(v) === '';
const n = (v) => Number(v) || 0;
const fund = (r) => s(r.hipdata_code).toUpperCase();
const discharged = (r) => !blank(r.dchdate);
const ALWAYS = () => true;

/* ---- ฟิลด์ที่ตรวจ ----
 * req(r)  : ช่องนี้ต้องลงสำหรับรายนี้หรือไม่
 * bad(r)  : ลงแล้วแต่ยังไม่ถูก/ว่าง (ใช้เมื่อ req = true)
 * save    : บันทึกกลับ table.col WHERE keyCol = ctx[ctxKey]   (ไม่มี = อ่านอย่างเดียว)
 * ref     : ตรวจว่ารหัสที่กรอกมีอยู่ในตารางอ้างอิง
 * name    : คอลัมน์ชื่อที่แสดงประกอบรหัส
 * detail  : ปุ่มดูรายการ (dx | drug | proc | charge)
 */
const FIELDS = [
  // ---------- ADMISSION ----------
  { key: 'ward', label: 'Ward', file: 'ADMISSION', type: TXT, w: 110, name: 'ward_name',
    req: ALWAYS, bad: (r) => blank(r.ward),
    save: { table: 'ipt', col: 'ward', keyCol: 'an', ctxKey: 'an' }, ref: { table: 'ward', col: 'ward' } },
  { key: 'pttype', label: 'สิทธิ (INSTYPE)', file: 'ADMISSION', type: SHOW, w: 150, name: 'pttype_name',
    req: ALWAYS, bad: (r) => blank(r.pttype), hint: 'เปลี่ยนสิทธิที่ HOSxP (กระทบการเงิน)' },
  { key: 'admtype', label: 'ประเภท Admit (TYPEIN)', file: 'ADMISSION', type: INT, w: 120, name: 'admtype_name',
    req: ALWAYS, bad: (r) => blank(r.admtype) || n(r.admtype) === 0,
    save: { table: 'ipt', col: 'ipt_admit_type_id', keyCol: 'an', ctxKey: 'an' }, ref: { table: 'ipt_admit_type', col: 'ipt_admit_type_id' } },
  { key: 'bw', label: 'น้ำหนักแรกรับ (กก.)', file: 'ADMISSION', type: FLOAT, w: 104,
    req: ALWAYS, bad: (r) => n(r.bw) <= 0, hint: 'ยังไม่ได้ลงน้ำหนักแรกรับ',
    save: { table: 'ipt', col: 'bw', keyCol: 'an', ctxKey: 'an' } },
  { key: 'dchstts', label: 'สถานะจำหน่าย (DISCHSTATUS)', file: 'ADMISSION', type: TXT, w: 120, name: 'dchstts_name',
    req: discharged, bad: (r) => blank(r.dchstts),
    save: { table: 'ipt', col: 'dchstts', keyCol: 'an', ctxKey: 'an' }, ref: { table: 'dchstts', col: 'dchstts' } },
  { key: 'dchtype', label: 'วิธีจำหน่าย (DISCHTYPE)', file: 'ADMISSION', type: TXT, w: 120, name: 'dchtype_name',
    req: discharged, bad: (r) => blank(r.dchtype),
    save: { table: 'ipt', col: 'dchtype', keyCol: 'an', ctxKey: 'an' }, ref: { table: 'dchtype', col: 'dchtype' } },
  // แพทย์เจ้าของคนไข้ (ipt_doctor_list ประเภท 1) — ipt.admdoctor มักเป็นจุดส่ง Admit (ER/NOPD) ไม่ใช่แพทย์
  { key: 'owner_doctor', label: 'แพทย์เจ้าของไข้', file: 'ADMISSION', type: TXT, w: 160, name: 'owner_doctor_name',
    req: ALWAYS, bad: (r) => blank(r.owner_doctor) || blank(r.owner_doctor_name), hint: 'ยังไม่ได้ลงแพทย์เจ้าของไข้ หรือรหัสไม่อยู่ในตาราง doctor',
    save: { custom: 'ownerDoctor', ctxKey: 'an' }, ref: { table: 'doctor', col: 'code' } },
  // ---------- DIAGNOSIS_IPD ----------
  { key: 'pdx', label: 'Pdx (ICD10)', file: 'DIAGNOSIS_IPD', type: SHOW, w: 100, name: 'pdx_name', detail: 'dx',
    req: discharged, bad: (r) => blank(r.pdx), hint: 'ยังไม่มีการวินิจฉัยหลัก (diagtype 1) — กดเพื่อเพิ่ม' },
  { key: 'dx_n', label: 'Dx ทั้งหมด', file: 'DIAGNOSIS_IPD', type: COUNT, w: 96, detail: 'dx',
    req: ALWAYS, bad: (r) => n(r.dx_n) === 0 || n(r.dx_nodoc) > 0, hint: 'ยังไม่มี Dx หรือมี Dx ที่ยังไม่ระบุแพทย์' },
  { key: 'extcause', label: 'สาเหตุภายนอก (V-Y)', file: 'DIAGNOSIS_IPD', type: COUNT, w: 110, detail: 'dx',
    req: (r) => n(r.t_n) > 0, bad: (r) => n(r.extcause) === 0, hint: 'มี Dx กลุ่ม T ต้องลงสาเหตุภายนอก V01-Y98' },
  // ---------- DRUG_IPD ----------
  { key: 'drug_n', label: 'ยา (รายการ)', file: 'DRUG_IPD', type: COUNT, w: 90, detail: 'drug',
    req: ALWAYS, bad: (r) => n(r.drug_n) === 0, hint: 'ยังไม่มีรายการยา' },
  // ---------- PROCEDURE_IPD ----------
  { key: 'proc_n', label: 'หัตถการ', file: 'PROCEDURE_IPD', type: COUNT, w: 90, detail: 'proc',
    req: ALWAYS, bad: (r) => n(r.proc_n) === 0 || n(r.proc_bad) > 0, hint: 'ยังไม่มีหัตถการ หรือมีหัตถการที่ไม่มีรหัส ICD9 / วันที่ / แพทย์' },
  // ---------- CHARGE_IPD ----------
  { key: 'charge_n', label: 'ค่าใช้จ่าย', file: 'CHARGE_IPD', type: COUNT, w: 120, detail: 'charge',
    req: ALWAYS, bad: (r) => n(r.charge_n) === 0, hint: 'ยังไม่มีรายการค่าใช้จ่าย' },
  // ---------- VITAL SIGN (ipd_nurse_note + ipt_vital_sign) ----------
  { key: 'vs_n', label: 'Vital sign (ครั้ง)', file: 'VITAL SIGN', type: COUNT, w: 120, detail: 'vs',
    req: ALWAYS, bad: (r) => n(r.vs_n) < r._vs_need, hint: 'ลง vital sign น้อยกว่า วันนอน × 3 ครั้ง' },
  // ---------- กองทุน ----------
  { key: 'hospmain', label: 'รพ.หลัก (hospmain)', file: 'กองทุน', type: TXT, w: 110, name: 'hospmain_name',
    req: (r) => HOSPMAIN_FUNDS.has(fund(r)), bad: (r) => blank(r.hospmain), hint: 'สิทธิ UCS / SSS / WEL ต้องระบุหน่วยบริการหลัก',
    save: { table: 'ipt_pttype', col: 'hospmain', keyCol: 'ipt_pttype_id', ctxKey: 'iptPttypeId' }, ref: { table: 'hospcode', col: 'hospcode' } },
  { key: 'pttypeno', label: 'เลขที่บัตรสิทธิ', file: 'กองทุน', type: TXT, w: 140,
    req: () => false, bad: () => false,
    save: { table: 'ipt_pttype', col: 'pttypeno', keyCol: 'ipt_pttype_id', ctxKey: 'iptPttypeId' } },
  { key: 'drg', label: 'DRG / AdjRW', file: 'กองทุน', type: SHOW, w: 120,
    req: (r) => discharged(r) && DRG_FUNDS.has(fund(r)), bad: (r) => blank(r.drg) || n(r.adjrw) <= 0,
    hint: 'สิทธิที่จ่ายตาม DRG (UCS/SSS/OFC/LGO/BKK) ต้อง Group DRG หลังจำหน่าย (ทำใน HOSxP)' },
  // ---------- คำแนะนำ (ไม่นับเป็นช่องที่ขาด) ----------
  { key: 'advice_n', label: '💡 คำแนะนำ DRG', file: 'คำแนะนำ', type: COUNT, w: 130, detail: 'advice',
    req: () => false, bad: () => false, hint: 'สิ่งที่ควรลงเพิ่ม / เรียงลำดับ ICD10-ICD9 เพื่อให้ DRG สะท้อนการรักษาจริง' }
];
const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

const META = FIELDS.map((f) => ({
  key: f.key, label: f.label, file: f.file, type: f.type, w: f.w, name: f.name || null,
  detail: f.detail || null, hint: f.hint || '', editable: !!f.save, keyReq: f.save ? f.save.ctxKey : null
}));

/* ---- SQL ---- */
// iptdiag.diagtype บางฐานเก็บ '1' บางฐานเก็บ '01' → ตัด 0 นำหน้าก่อนเทียบ
const DT = "TRIM(LEADING '0' FROM TRIM(d.diagtype))";
// บันทึกพยาบาลที่มีค่า vital sign อย่างน้อย 1 ค่า (นับเป็น 1 ครั้ง)
const VS_HAS = '(COALESCE(nn.temperature, 0) > 0 OR COALESCE(nn.pulse, 0) > 0 OR COALESCE(nn.respiratory_rate, 0) > 0 OR COALESCE(nn.bp_systolic, 0) > 0)';
// แพทย์เจ้าของคนไข้ 1 คน: ที่ active ก่อน แล้วเอารายการล่าสุด (ใช้เป็น WHERE ... ORDER ... LIMIT 1 ของ subquery)
const OWNER = "l.an = i.an AND l.ipt_doctor_type_id = 1 ORDER BY CASE WHEN l.active_doctor = 'Y' THEN 0 ELSE 1 END, l.ipt_doctor_list_id DESC LIMIT 1";
const NAME ="CONCAT(COALESCE(p.pname,''), COALESCE(p.fname,''), ' ', COALESCE(p.lname,''))";
const SELECT = [
  'SELECT i.an, i.hn, i.vn, i.regdate, i.regtime, i.dchdate, i.dchtime,',
  '  i.ward, w.name AS ward_name, i.pttype, t.name AS pttype_name, t.hipdata_code,',
  '  i.ipt_admit_type_id AS admtype, iat.ipt_admit_type_name AS admtype_name, i.bw,',
  '  i.dchstts, ds.name AS dchstts_name, i.dchtype, dt.name AS dchtype_name,',
  '  i.drg, i.adjrw,',
  '  (SELECT l.ipt_doctor_list_id FROM ipt_doctor_list l WHERE ' + OWNER + ') AS owner_id,',
  '  (SELECT l.doctor FROM ipt_doctor_list l WHERE ' + OWNER + ') AS owner_doctor,',
  '  (SELECT dc.name FROM ipt_doctor_list l JOIN doctor dc ON dc.code = l.doctor WHERE ' + OWNER + ') AS owner_doctor_name,',
  '  p.cid, p.birthday, ' + NAME + ' AS ptname,',
  '  pt.ipt_pttype_id, pt.hospmain, pt.pttypeno,',
  '  (SELECT h.name FROM hospcode h WHERE h.hospcode = pt.hospmain LIMIT 1) AS hospmain_name,',
  "  (SELECT d.icd10 FROM iptdiag d WHERE d.an = i.an AND " + DT + " = '1' LIMIT 1) AS pdx,",
  "  (SELECT x.name FROM iptdiag d JOIN icd101 x ON x.code = d.icd10 WHERE d.an = i.an AND " + DT + " = '1' LIMIT 1) AS pdx_name,",
  '  (SELECT COUNT(*) FROM iptdiag d WHERE d.an = i.an) AS dx_n,',
  "  (SELECT COUNT(*) FROM iptdiag d WHERE d.an = i.an AND (d.doctor IS NULL OR TRIM(d.doctor) = '')) AS dx_nodoc,",
  "  (SELECT COUNT(*) FROM iptdiag d WHERE d.an = i.an AND UPPER(SUBSTR(d.icd10, 1, 1)) = 'T') AS t_n,",
  "  (SELECT COUNT(*) FROM iptdiag d WHERE d.an = i.an AND UPPER(SUBSTR(d.icd10, 1, 1)) IN ('V', 'W', 'X', 'Y')) AS extcause,",
  '  (SELECT COUNT(*) FROM opitemrece r JOIN drugitems di ON di.icode = r.icode WHERE r.an = i.an) AS drug_n,',
  '  (SELECT COUNT(*) FROM iptoprt o WHERE o.an = i.an) AS proc_n,',
  "  (SELECT COUNT(*) FROM iptoprt o WHERE o.an = i.an AND (o.opdate IS NULL OR o.icd9 IS NULL OR TRIM(o.icd9) = '' OR o.doctor IS NULL OR TRIM(o.doctor) = '')) AS proc_bad,",
  '  (SELECT COUNT(*) FROM ipd_nurse_note nn WHERE nn.an = i.an AND ' + VS_HAS + ') +',
  '  (SELECT COUNT(DISTINCT v.vital_sign_datetime) FROM ipt_vital_sign v WHERE v.an = i.an) AS vs_n,',
  '  (SELECT COUNT(*) FROM opitemrece r WHERE r.an = i.an) AS charge_n,',
  '  (SELECT SUM(r.sum_price) FROM opitemrece r WHERE r.an = i.an) AS charge_sum',
  'FROM ipt i',
  '  LEFT JOIN patient p ON p.hn = i.hn',
  '  LEFT JOIN ward w ON w.ward = i.ward',
  '  LEFT JOIN pttype t ON t.pttype = i.pttype',
  '  LEFT JOIN ipt_admit_type iat ON iat.ipt_admit_type_id = i.ipt_admit_type_id',
  '  LEFT JOIN dchstts ds ON ds.dchstts = i.dchstts',
  '  LEFT JOIN dchtype dt ON dt.dchtype = i.dchtype',
  '  LEFT JOIN ipt_pttype pt ON pt.ipt_pttype_id = (SELECT MIN(x.ipt_pttype_id) FROM ipt_pttype x WHERE x.an = i.an)'
].join('\n');

/** เงื่อนไข WHERE ตามมุมมอง + ward */
function whereOf(basis, from, to, ward) {
  const where = [], params = [];
  if (basis === 'dch') { where.push('i.dchdate BETWEEN {{D}} AND {{D}}'); params.push(from, to); }
  else if (basis === 'adm') { where.push('i.regdate BETWEEN {{D}} AND {{D}}'); params.push(from, to); }
  else where.push('i.dchdate IS NULL');
  if (ward === '__none__') where.push("(i.ward IS NULL OR TRIM(i.ward) = '')");
  else if (ward) { where.push('i.ward = ?'); params.push(ward); }
  return { sql: where.join(' AND '), params };
}

function toISO(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date && !isNaN(v)) return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : String(v).slice(0, 10);
}
const dayDiff = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);

function decorate(r) {
  const out = Object.assign({}, r);
  ['regdate', 'dchdate', 'birthday'].forEach((k) => { out[k] = toISO(out[k]); });
  out.regtime = s(out.regtime).slice(0, 5);
  out.dchtime = s(out.dchtime).slice(0, 5);
  ['dchstts', 'dchtype', 'ward', 'pttype', 'hipdata_code'].forEach((k) => { out[k] = s(out[k]); });
  ['dx_n', 'dx_nodoc', 't_n', 'extcause', 'drug_n', 'proc_n', 'proc_bad', 'charge_n', 'vs_n'].forEach((k) => { out[k] = n(out[k]); });
  out.charge_sum = Math.round(n(out.charge_sum) * 100) / 100;
  out._age_days = out.birthday && out.regdate ? dayDiff(out.birthday, out.regdate) : null;
  out._los = out.regdate ? dayDiff(out.regdate, out.dchdate || toISO(new Date())) : null;
  out._discharged = discharged(out);
  // vital sign ขั้นต่ำ = วันนอน × 3 (Admit/จำหน่ายวันเดียวกันนับเป็น 1 วัน)
  out._vs_need = Math.max(out._los || 0, 1) * 3;

  const req = [], missing = [];
  for (const f of FIELDS) {
    let need = false;
    try { need = !!f.req(out); } catch (e) { need = false; }
    if (!need) continue;
    req.push(f.key);
    if (f.bad(out)) missing.push(f.key);
  }
  out._req = req;
  out._missing = missing;
  out._complete = missing.length === 0;
  out._percent = req.length ? Math.round(((req.length - missing.length) / req.length) * 100) : 100;
  out._ctx = { an: out.an, vn: out.vn, hn: out.hn, iptPttypeId: out.ipt_pttype_id, ownerId: out.owner_id };
  return out;
}

async function ipdList(cfg, basis, from, to, ward, limit) {
  if (!BASIS[basis]) basis = 'stay';
  const w = whereOf(basis, from, to, ward);
  const sql = SELECT + '\nWHERE ' + w.sql + '\nORDER BY i.ward, i.an LIMIT ' + Math.min(Number(limit) || 5000, 20000);
  const rows = await db.query(cfg, sqlFor(cfg, sql), w.params);
  return advice.annotate(cfg, rows.map(decorate));
}

async function getRow(cfg, an) {
  const rows = await db.query(cfg, SELECT + '\nWHERE i.an = ? LIMIT 1', [String(an)]);
  return rows.length ? (await advice.annotate(cfg, [decorate(rows[0])]))[0] : null;
}

/** ward ที่มีผู้ป่วยตามมุมมองที่เลือก (ไม่กรอง ward) */
async function wards(cfg, basis, from, to) {
  if (!BASIS[basis]) basis = 'stay';
  const w = whereOf(basis, from, to, '');
  const sql = [
    'SELECT i.ward AS ward, MAX(w.name) AS name, COUNT(*) AS cnt',
    'FROM ipt i LEFT JOIN ward w ON w.ward = i.ward',
    'WHERE ' + w.sql,
    'GROUP BY i.ward ORDER BY i.ward'
  ].join('\n');
  const rows = await db.query(cfg, sqlFor(cfg, sql), w.params);
  return rows.map((r) => ({
    ward: blank(r.ward) ? '__none__' : s(r.ward),
    name: blank(r.ward) ? '(ไม่ระบุ ward)' : (r.name || ('Ward ' + s(r.ward))),
    count: n(r.cnt)
  }));
}

function summarize(rows) {
  const miss = {};
  FIELDS.forEach((f) => { miss[f.key] = 0; });
  let complete = 0, pctSum = 0, dch = 0;
  for (const r of rows) {
    if (r._complete) complete++;
    if (r._discharged) dch++;
    pctSum += r._percent;
    r._missing.forEach((k) => { miss[k]++; });
  }
  return {
    total: rows.length, complete, incomplete: rows.length - complete, discharged: dch,
    advice: rows.filter((r) => r.advice_n > 0).length,
    percent: rows.length ? Math.round(pctSum / rows.length) : 0,
    fields: FIELDS.filter((f) => miss[f.key] > 0)
      .map((f) => ({ key: f.key, label: f.label, file: f.file, missing: miss[f.key], hint: f.hint || '' }))
      .sort((a, b) => b.missing - a.missing)
  };
}

/* ---- รายละเอียดต่อ AN (ปุ่มดูรายการ) ---- */
const DETAIL_SQL = {
  dx: [
    'SELECT d.ipt_diag_id AS id, ' + DT + ' AS diagtype, d.icd10, x.name AS icd_name, d.doctor, dc.name AS doctor_name',
    'FROM iptdiag d LEFT JOIN icd101 x ON x.code = d.icd10 LEFT JOIN doctor dc ON dc.code = d.doctor',
    'WHERE d.an = ? ORDER BY ' + DT + ', d.ipt_diag_id'
  ],
  proc: [
    'SELECT o.iptoprt_id AS id, o.opdate, o.optime, o.enddate, o.endtime, o.icd9, c.name AS icd9_name,',
    '  o.doctor, dc.name AS doctor_name, o.iprice, o.iqty',
    'FROM iptoprt o LEFT JOIN icd9cm1 c ON c.code = o.icd9 LEFT JOIN doctor dc ON dc.code = o.doctor',
    'WHERE o.an = ? ORDER BY o.opdate, o.optime, o.iptoprt_id'
  ],
  drug: [
    'SELECT r.rxdate, r.icode, di.name, di.strength, di.units, r.qty, r.unitprice, r.sum_price',
    'FROM opitemrece r JOIN drugitems di ON di.icode = r.icode',
    'WHERE r.an = ? ORDER BY r.rxdate, r.rxtime, di.name LIMIT 2000'
  ],
  charge: [
    'SELECT r.income, MAX(n.name) AS income_name, COUNT(*) AS items, SUM(r.qty) AS qty, SUM(r.sum_price) AS sum_price',
    'FROM opitemrece r LEFT JOIN income n ON n.income = r.income',
    'WHERE r.an = ? GROUP BY r.income ORDER BY r.income'
  ]
};

/** vital sign ทุกครั้งของ AN (บันทึกพยาบาล + ตาราง ipt_vital_sign ที่เก็บแยกรายค่า) เรียงตามเวลา */
async function vitalSigns(cfg, an) {
  const nurse = await db.query(cfg, [
    'SELECT nn.note_date, nn.note_time, nn.temperature, nn.pulse, nn.respiratory_rate, nn.bp_systolic, nn.bp_diastolic, nn.spo2_ra, nn.staff',
    'FROM ipd_nurse_note nn WHERE nn.an = ? AND ' + VS_HAS
  ].join('\n'), [String(an)]);
  const graphic = await db.query(cfg, [
    'SELECT v.vital_sign_datetime AS dt, MAX(v.staff) AS staff,',
    '  MAX(CASE WHEN v.vital_sign_id = 1 THEN v.vital_sign_value END) AS temperature,',
    '  MAX(CASE WHEN v.vital_sign_id = 2 THEN v.vital_sign_value END) AS pulse,',
    '  MAX(CASE WHEN v.vital_sign_id = 3 THEN v.vital_sign_value END) AS respiratory_rate,',
    '  MAX(CASE WHEN v.vital_sign_id = 4 THEN v.vital_sign_value END) AS bp_systolic,',
    '  MAX(CASE WHEN v.vital_sign_id = 5 THEN v.vital_sign_value END) AS bp_diastolic',
    'FROM ipt_vital_sign v WHERE v.an = ? GROUP BY v.vital_sign_datetime'
  ].join('\n'), [String(an)]);
  const pick = (r) => ({ temperature: r.temperature, pulse: r.pulse, rr: r.respiratory_rate, sbp: r.bp_systolic, dbp: r.bp_diastolic, staff: r.staff });
  const out = nurse.map((r) => Object.assign({ date: toISO(r.note_date), time: s(r.note_time).slice(0, 5), spo2: r.spo2_ra, src: 'บันทึกพยาบาล' }, pick(r)))
    .concat(graphic.map((r) => {
      const dt = r.dt instanceof Date ? r.dt : new Date(String(r.dt).replace(' ', 'T'));
      return Object.assign({
        date: toISO(dt), time: isNaN(dt) ? '' : ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2),
        spo2: null, src: 'Vital sign chart'
      }, pick(r));
    }));
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

async function detail(cfg, an, kind) {
  if (kind === 'vs') return vitalSigns(cfg, an);
  if (kind === 'advice') {
    const [row, dx, proc] = await Promise.all([getRow(cfg, an), detail(cfg, an, 'dx'), detail(cfg, an, 'proc')]);
    return { advice: row ? row._advice : [], order: advice.suggestedOrder(dx, proc), row };
  }
  const q = DETAIL_SQL[kind];
  if (!q) { const e = new Error('ไม่รู้จักชนิดรายการ'); e.status = 400; throw e; }
  const rows = await db.query(cfg, q.join('\n'), [String(an)]);
  return rows.map((r) => {
    const o = Object.assign({}, r);
    ['opdate', 'enddate', 'rxdate'].forEach((k) => { if (k in o) o[k] = toISO(o[k]); });
    ['optime', 'endtime'].forEach((k) => { if (k in o) o[k] = s(o[k]).slice(0, 5); });
    return o;
  });
}

/* ---- บันทึก 1 ช่อง ---- */
async function saveField(cfg, field, ctx, value) {
  ctx = ctx || {};
  const f = FIELD_BY_KEY[field];
  if (!f || !f.save) { const e = new Error('ฟิลด์นี้แก้ไขไม่ได้'); e.status = 400; throw e; }
  const raw = s(value);
  if (raw === '') { const e = new Error('กรุณากรอกค่า'); e.status = 400; throw e; }

  let val = raw;
  if (f.type === INT) {
    if (!/^-?\d+$/.test(raw)) { const e = new Error('ต้องเป็นจำนวนเต็ม'); e.status = 400; throw e; }
    val = parseInt(raw, 10);
  } else if (f.type === FLOAT) {
    if (!/^\d+(\.\d+)?$/.test(raw)) { const e = new Error('ต้องเป็นตัวเลข'); e.status = 400; throw e; }
    val = Number(raw);
  }
  if (f.pattern && !f.pattern.test(raw)) { const e = new Error(f.hint || 'รูปแบบไม่ถูกต้อง'); e.status = 400; throw e; }

  if (f.ref) {
    const hit = await db.query(cfg, 'SELECT 1 AS ok FROM ' + f.ref.table + ' WHERE ' + f.ref.col + ' = ? LIMIT 1', [val]);
    if (!hit.length) { const e = new Error('ไม่พบรหัส "' + raw + '" ในตาราง ' + f.ref.table); e.status = 400; throw e; }
  }

  if (f.save.custom === 'ownerDoctor') return saveOwnerDoctor(cfg, ctx, val);

  const keyVal = ctx[f.save.ctxKey];
  if (blank(keyVal)) { const e = new Error('ไม่พบระเบียนต้นทาง (' + f.save.table + ')'); e.status = 400; throw e; }
  const r = await db.execute(cfg,
    'UPDATE ' + f.save.table + ' SET ' + f.save.col + ' = ? WHERE ' + f.save.keyCol + ' = ?', [val, keyVal]);
  if (!r.affected) { const e = new Error('ไม่พบระเบียนต้นทาง (' + f.save.table + ')'); e.status = 404; throw e; }
  return { affected: r.affected, value: val };
}

/** แพทย์เจ้าของคนไข้: มีแถวอยู่แล้ว → เปลี่ยนแพทย์ในแถวนั้น, ยังไม่มี → เพิ่มแถวประเภท 1 (active) */
async function saveOwnerDoctor(cfg, ctx, doctor) {
  if (!blank(ctx.ownerId)) {
    const r = await db.execute(cfg, 'UPDATE ipt_doctor_list SET doctor = ? WHERE ipt_doctor_list_id = ? AND an = ?',
      [doctor, n(ctx.ownerId), String(ctx.an)]);
    if (r.affected) return { affected: r.affected, value: doctor };
  }
  const ipt = await iptOf(cfg, ctx.an);
  const id = await nextId(cfg, 'ipt_doctor_list_id', 'ipt_doctor_list', 'ipt_doctor_list_id');
  await db.execute(cfg,
    "INSERT INTO ipt_doctor_list (ipt_doctor_list_id, an, doctor, ipt_doctor_type_id, active_doctor, incharge_date, incharge_time) " +
    "VALUES (?, ?, ?, 1, 'Y', CURRENT_DATE, CURRENT_TIME)", [id, ipt.an, doctor]);
  return { affected: 1, value: doctor };
}

/* ---- การวินิจฉัย (iptdiag) / หัตถการ (iptoprt) — เพิ่ม/แก้/ลบ จากหน้าต่างรายละเอียด ---- */
const err = (msg, status) => { const e = new Error(msg); e.status = status || 400; return e; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(s(v));
const isTime = (v) => /^\d{2}:\d{2}(:\d{2})?$/.test(s(v));

/** id ถัดไปจากตาราง serial ของ HOSxP (get_serialnumber) — ถ้าไม่มีฟังก์ชันใช้ MAX+1 */
async function nextId(cfg, name, table, col) {
  try {
    const r = await db.query(cfg, 'SELECT get_serialnumber(?) AS id', [name]);
    if (r.length && n(r[0].id) > 0) return n(r[0].id);
  } catch (e) { /* ไม่มีฟังก์ชัน */ }
  const r = await db.query(cfg, 'SELECT COALESCE(MAX(' + col + '), 0) + 1 AS id FROM ' + table, []);
  return n(r[0].id);
}

async function iptOf(cfg, an) {
  const r = await db.query(cfg, 'SELECT an, hn FROM ipt WHERE an = ? LIMIT 1', [String(an)]);
  if (!r.length) throw err('ไม่พบ AN ' + an, 404);
  return r[0];
}
async function mustExist(cfg, table, col, val, label) {
  const r = await db.query(cfg, 'SELECT 1 AS ok FROM ' + table + ' WHERE ' + col + ' = ? LIMIT 1', [val]);
  if (!r.length) throw err('ไม่พบ' + label + ' "' + val + '"');
}

/** รูปแบบ diagtype ที่ฐานนี้ใช้ ('1' หรือ '01') — ดูจากข้อมูลจริง แคชไว้ */
let _dtWidth = null;
async function diagTypeValue(cfg, t) {
  if (_dtWidth === null) {
    try {
      const r = await db.query(cfg, 'SELECT diagtype FROM iptdiag WHERE diagtype IS NOT NULL LIMIT 1', []);
      _dtWidth = r.length ? s(r[0].diagtype).length : 1;
    } catch (e) { _dtWidth = 1; }
  }
  return _dtWidth >= 2 ? ('0' + t).slice(-2) : t;
}

async function addDiag(cfg, an, icd10, diagtype, doctor, staff) {
  const code = s(icd10).toUpperCase().replace('.', '');
  const t = s(diagtype);
  if (!code) throw err('กรุณาระบุรหัส ICD-10');
  if (!/^[1-7]$/.test(t)) throw err('ประเภทการวินิจฉัยต้องเป็น 1-7');
  if (!s(doctor)) throw err('กรุณาเลือกแพทย์');
  const ipt = await iptOf(cfg, an);
  await mustExist(cfg, 'icd101', 'code', code, 'รหัส ICD-10');
  await mustExist(cfg, 'doctor', 'code', s(doctor), 'รหัสแพทย์');
  if (t === '1') {
    const pdx = await db.query(cfg, 'SELECT 1 AS ok FROM iptdiag d WHERE d.an = ? AND ' + DT + " = '1' LIMIT 1", [ipt.an]);
    if (pdx.length) throw err('AN นี้มี Pdx แล้ว — เปลี่ยนประเภทของรายการเดิมก่อน');
  }
  const id = await nextId(cfg, 'ipt_diag_id', 'iptdiag', 'ipt_diag_id');
  await db.execute(cfg,
    'INSERT INTO iptdiag (ipt_diag_id, an, hn, icd10, diagtype, doctor, staff, entry_datetime, modify_datetime) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
    [id, ipt.an, ipt.hn, code, await diagTypeValue(cfg, t), s(doctor), s(staff).slice(0, 25) || null]);
  return { id };
}

async function updateDiag(cfg, an, id, data) {
  const sets = [], vals = [];
  if (data.diagtype !== undefined) {
    const t = s(data.diagtype);
    if (!/^[1-7]$/.test(t)) throw err('ประเภทการวินิจฉัยต้องเป็น 1-7');
    sets.push('diagtype = ?'); vals.push(await diagTypeValue(cfg, t));
  }
  if (data.doctor !== undefined) {
    if (!s(data.doctor)) throw err('กรุณาเลือกแพทย์');
    await mustExist(cfg, 'doctor', 'code', s(data.doctor), 'รหัสแพทย์');
    sets.push('doctor = ?'); vals.push(s(data.doctor));
  }
  if (!sets.length) throw err('ไม่มีข้อมูลที่จะแก้ไข');
  const r = await db.execute(cfg, 'UPDATE iptdiag SET ' + sets.join(', ') + ', modify_datetime = CURRENT_TIMESTAMP WHERE ipt_diag_id = ? AND an = ?',
    vals.concat([n(id), String(an)]));
  if (!r.affected) throw err('ไม่พบรายการวินิจฉัยนี้', 404);
  return { affected: r.affected };
}

async function deleteDiag(cfg, an, id) {
  const r = await db.execute(cfg, 'DELETE FROM iptdiag WHERE ipt_diag_id = ? AND an = ?', [n(id), String(an)]);
  if (!r.affected) throw err('ไม่พบรายการวินิจฉัยนี้', 404);
  return { affected: r.affected };
}

function procValues(d) {
  const out = {};
  if (d.icd9 !== undefined) out.icd9 = s(d.icd9).replace('.', '');
  ['opdate', 'enddate'].forEach((k) => {
    if (d[k] === undefined) return;
    if (!isDate(d[k])) throw err('วันที่ต้องเป็นรูปแบบ YYYY-MM-DD');
    out[k] = s(d[k]);
  });
  ['optime', 'endtime'].forEach((k) => {
    if (d[k] === undefined || s(d[k]) === '') return;
    if (!isTime(d[k])) throw err('เวลาต้องเป็นรูปแบบ HH:MM');
    out[k] = s(d[k]).length === 5 ? s(d[k]) + ':00' : s(d[k]);
  });
  if (d.doctor !== undefined) out.doctor = s(d.doctor);
  return out;
}

async function addProc(cfg, an, data, staff) {
  const v = procValues(data || {});
  if (!v.icd9) throw err('กรุณาระบุรหัส ICD-9');
  if (!v.opdate) throw err('กรุณาระบุวันที่ทำหัตถการ');
  if (!v.doctor) throw err('กรุณาเลือกแพทย์');
  const ipt = await iptOf(cfg, an);
  await mustExist(cfg, 'icd9cm1', 'code', v.icd9, 'รหัส ICD-9');
  await mustExist(cfg, 'doctor', 'code', v.doctor, 'รหัสแพทย์');
  const id = await nextId(cfg, 'iptoprt_id', 'iptoprt', 'iptoprt_id');
  await db.execute(cfg,
    'INSERT INTO iptoprt (iptoprt_id, an, icd9, opdate, optime, enddate, endtime, doctor, priority, staff, entry_datetime, modify_datetime) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
    [id, ipt.an, v.icd9, v.opdate, v.optime || null, v.enddate || v.opdate, v.endtime || v.optime || null, v.doctor, s(staff).slice(0, 25) || null]);
  return { id };
}

async function updateProc(cfg, an, id, data) {
  const v = procValues(data || {});
  if (v.icd9 !== undefined) { if (!v.icd9) throw err('กรุณาระบุรหัส ICD-9'); await mustExist(cfg, 'icd9cm1', 'code', v.icd9, 'รหัส ICD-9'); }
  if (v.doctor !== undefined) { if (!v.doctor) throw err('กรุณาเลือกแพทย์'); await mustExist(cfg, 'doctor', 'code', v.doctor, 'รหัสแพทย์'); }
  const keys = Object.keys(v);
  if (!keys.length) throw err('ไม่มีข้อมูลที่จะแก้ไข');
  const r = await db.execute(cfg,
    'UPDATE iptoprt SET ' + keys.map((k) => k + ' = ?').join(', ') + ', modify_datetime = CURRENT_TIMESTAMP WHERE iptoprt_id = ? AND an = ?',
    keys.map((k) => v[k]).concat([n(id), String(an)]));
  if (!r.affected) throw err('ไม่พบรายการหัตถการนี้', 404);
  return { affected: r.affected };
}

async function deleteProc(cfg, an, id) {
  const r = await db.execute(cfg, 'DELETE FROM iptoprt WHERE iptoprt_id = ? AND an = ?', [n(id), String(an)]);
  if (!r.affected) throw err('ไม่พบรายการหัตถการนี้', 404);
  return { affected: r.affected };
}

async function searchIcd9(cfg, term) {
  const q = s(term);
  if (q.length < 1) return [];
  const like = '%' + q + '%';
  const rows = await db.query(cfg,
    'SELECT code, name FROM icd9cm1 WHERE code LIKE ? OR name LIKE ? ORDER BY code LIMIT 40', [q.replace('.', '') + '%', like]);
  return rows.map((r) => ({ code: r.code, name: r.name }));
}

module.exports = {
  BASIS, META, ipdList, getRow, wards, summarize, detail, saveField,
  addDiag, updateDiag, deleteDiag, addProc, updateProc, deleteProc, searchIcd9
};
