'use strict';
/**
 * ตรวจสอบ/เพิ่มข้อมูลงานฝากครรภ์ (แฟ้ม PRENATAL / ANC / LABOR / POSTNATAL)
 * แยกเป็น 4 มุมมอง (mode) ตามแฟ้ม 43 แฟ้ม:
 *   prenatal  : person_anc (1 แถว/การตั้งครรภ์)                        คีย์ person_anc_id
 *   anc       : person_anc_service (1 แถว/ครั้งที่มาฝากครรภ์)          คีย์ person_anc_service_id
 *   labor     : person_anc (เฉพาะรายที่คลอดแล้ว labor_date IS NOT NULL) คีย์ person_anc_id
 *   postnatal : person_anc_preg_care (การดูแลหลังคลอด)                 คีย์ person_anc_preg_care_id
 * หมายเหตุ: ชื่อคอลัมน์จริงใน HOSxP XE ต่างจากสเปกส่งออก 43 แฟ้ม จึง map ไปยังคอลัมน์ต้นทางที่แก้ไขได้จริง
 */
const db = require('./db');

const TXT = 'text', INT = 'int', FLOAT = 'float', DATE = 'date';

/* ---- ฟิลด์ที่ตรวจ/แก้ไขได้ต่อ mode ----
 * save: { table, col, keyCol, ctxKey } — บันทึกกลับต้นทางตาม keyCol = ctx[ctxKey]
 * zeroBlank: true → ค่า 0 ถือว่ายังไม่ได้บันทึก (แดง)
 */
const MODES = {
  all: {
    label: 'รวมทุกงาน',
    dateCol: 'pa.anc_register_date',
    fields: [
      // ---- ฝากครรภ์ (person_anc) ----
      { key: 'gravida',     label: 'ครรภ์ที่',        type: INT,  w: 80,  check: true, zeroBlank: true, save: { table: 'person_anc', col: 'preg_no',              keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'lmp',         label: 'LMP',             type: DATE, w: 118, check: false, save: { table: 'person_anc', col: 'lmp',                    keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'edc',         label: 'EDC',             type: DATE, w: 118, check: false, save: { table: 'person_anc', col: 'edc',                    keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'vdrl',        label: 'VDRL',            type: TXT,  w: 84,  check: true,  save: { table: 'person_anc', col: 'blood_vdrl1_result',      keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'hiv',         label: 'HIV',             type: TXT,  w: 84,  check: true,  save: { table: 'person_anc', col: 'blood_hiv1_result',       keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'hct',         label: 'HCT',             type: TXT,  w: 84,  check: true,  save: { table: 'person_anc', col: 'blood_hct_result',        keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'thalassemia', label: 'Thalas.',         type: INT,  w: 96,  check: true,  save: { table: 'person_anc', col: 'thalassaemia_result_id',   keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'anc_provider',label: 'ผู้ฝากครรภ์',     type: TXT,  w: 140, check: true,  save: { table: 'person_anc', col: 'anc_register_staff',      keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'height',      label: 'ส่วนสูง',         type: FLOAT,w: 92,  check: true,  save: { table: 'person',     col: 'height_cm',              keyCol: 'person_id',     ctxKey: 'personId' } },
      { key: 'cid',         label: 'เลขบัตร ปชช.',    type: TXT,  w: 140, check: true,  save: { table: 'person',     col: 'cid',                    keyCol: 'person_id',     ctxKey: 'personId' } },
      // ---- ANC ครั้งล่าสุด (person_anc_service) ----
      { key: 'ancno',       label: 'ANC ครั้งล่าสุด',  type: INT,  w: 110, check: true, zeroBlank: true, save: { table: 'person_anc_service', col: 'anc_service_number', keyCol: 'person_anc_service_id', ctxKey: 'svcId' } },
      { key: 'ga',          label: 'อายุครรภ์(สป.)',   type: INT,  w: 108, check: true, zeroBlank: true, save: { table: 'person_anc_service', col: 'pa_week',           keyCol: 'person_anc_service_id', ctxKey: 'svcId' } },
      { key: 'ancresult',   label: 'ผลตรวจ ANC',      type: TXT,  w: 96,  check: true, save: { table: 'person_anc_service', col: 'service_result',    keyCol: 'person_anc_service_id', ctxKey: 'svcId' } },
      { key: 'weight',      label: 'น้ำหนัก(กก.)',    type: FLOAT,w: 108, check: true, save: { table: 'opdscreen',          col: 'bw',                keyCol: 'vn',                   ctxKey: 'vn' } },
      // ---- คลอด (person_anc) — ไม่บังคับ (ยังไม่คลอดไม่ต้องแดง) ----
      { key: 'bdate',       label: 'วันคลอด',          type: DATE, w: 118, check: false, save: { table: 'person_anc', col: 'labor_date',              keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'bresult',     label: 'ผลคลอด(ICD10)',    type: TXT,  w: 112, check: false, save: { table: 'person_anc', col: 'labor_icd10',             keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'bplace',      label: 'สถานที่คลอด',      type: INT,  w: 104, check: false, save: { table: 'person_anc', col: 'labor_place_id',          keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'btype',       label: 'วิธีคลอด',         type: INT,  w: 96,  check: false, save: { table: 'person_anc', col: 'labour_type_id',          keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'bdoctor',     label: 'ผู้ทำคลอด',        type: INT,  w: 96,  check: false, save: { table: 'person_anc', col: 'labor_doctor_type_id',    keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'lborn',       label: 'เกิดมีชีพ',        type: INT,  w: 90,  check: false, save: { table: 'person_anc', col: 'alive_child_count',       keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'sborn',       label: 'ตายคลอด',          type: INT,  w: 90,  check: false, save: { table: 'person_anc', col: 'dead_child_count',        keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      // ---- ดูแลหลังคลอด ครั้งล่าสุด (person_anc_preg_care) — ไม่บังคับ ----
      { key: 'ppcare',      label: 'วันดูแลหลังคลอด',  type: DATE, w: 122, check: false, save: { table: 'person_anc_preg_care', col: 'care_date',       keyCol: 'person_anc_preg_care_id', ctxKey: 'careId' } },
      { key: 'ppresult',    label: 'ตรวจมารดาหลัง',    type: TXT,  w: 110, check: false, save: { table: 'person_anc_preg_care', col: 'perineum_normal', keyCol: 'person_anc_preg_care_id', ctxKey: 'careId' } },
      { key: 'pp_provider', label: 'ผู้ดูแลหลังคลอด',  type: TXT,  w: 130, check: false, save: { table: 'person_anc_preg_care', col: 'doctor_code',     keyCol: 'person_anc_preg_care_id', ctxKey: 'careId' } }
    ]
  },
  prenatal: {
    label: 'ฝากครรภ์',
    dateCol: 'pa.anc_register_date',
    fields: [
      { key: 'gravida',     label: 'ครรภ์ที่',        type: INT,  w: 80,  check: true, zeroBlank: true, save: { table: 'person_anc', col: 'preg_no',                keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'lmp',         label: 'LMP',             type: DATE, w: 120, check: false,                  save: { table: 'person_anc', col: 'lmp',                    keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'edc',         label: 'EDC (กำหนดคลอด)', type: DATE, w: 120, check: false,                  save: { table: 'person_anc', col: 'edc',                    keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'vdrl',        label: 'VDRL',            type: TXT,  w: 90,  check: true,  save: { table: 'person_anc', col: 'blood_vdrl1_result',      keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'hiv',         label: 'HIV',             type: TXT,  w: 90,  check: true,  save: { table: 'person_anc', col: 'blood_hiv1_result',       keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'hct',         label: 'HCT',             type: TXT,  w: 90,  check: true,  save: { table: 'person_anc', col: 'blood_hct_result',        keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'thalassemia', label: 'Thalassemia',     type: INT,  w: 110, check: true,  save: { table: 'person_anc', col: 'thalassaemia_result_id',   keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'provider',    label: 'ผู้ให้บริการ',    type: TXT,  w: 150, check: true,  save: { table: 'person_anc', col: 'anc_register_staff',      keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'height',      label: 'ส่วนสูง (ซม.)',   type: FLOAT,w: 100, check: true,  save: { table: 'person',     col: 'height_cm',              keyCol: 'person_id',     ctxKey: 'personId' } },
      { key: 'cid',         label: 'เลขบัตร ปชช.',    type: TXT,  w: 140, check: true,  save: { table: 'person',     col: 'cid',                    keyCol: 'person_id',     ctxKey: 'personId' } }
    ]
  },
  anc: {
    label: 'มาตามนัด (ANC)',
    dateCol: 's.anc_service_date',
    fields: [
      { key: 'ancno',     label: 'ANC ครั้งที่',   type: INT,  w: 90,  check: true, zeroBlank: true, save: { table: 'person_anc_service', col: 'anc_service_number', keyCol: 'person_anc_service_id', ctxKey: 'svcId' } },
      { key: 'ga',        label: 'อายุครรภ์(สัปดาห์)', type: INT, w: 120, check: true, zeroBlank: true, save: { table: 'person_anc_service', col: 'pa_week',           keyCol: 'person_anc_service_id', ctxKey: 'svcId' } },
      { key: 'ancresult', label: 'ผลการตรวจ',      type: TXT,  w: 100, check: true, save: { table: 'person_anc_service', col: 'service_result',    keyCol: 'person_anc_service_id', ctxKey: 'svcId' } },
      { key: 'weight',    label: 'น้ำหนัก(กก.)',   type: FLOAT,w: 110, check: true, save: { table: 'opdscreen',          col: 'bw',                keyCol: 'vn',                   ctxKey: 'vn' } },
      { key: 'cid',       label: 'เลขบัตร ปชช.',   type: TXT,  w: 140, check: true, save: { table: 'person',             col: 'cid',               keyCol: 'person_id',            ctxKey: 'personId' } }
    ]
  },
  labor: {
    label: 'คลอด',
    dateCol: 'pa.labor_date',
    onlyDelivered: true,
    fields: [
      { key: 'bdate',   label: 'วันคลอด',           type: DATE, w: 120, check: true, save: { table: 'person_anc', col: 'labor_date',              keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'bresult', label: 'ผลคลอด (ICD10)',    type: TXT,  w: 120, check: true, save: { table: 'person_anc', col: 'labor_icd10',             keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'bplace',  label: 'สถานที่คลอด',       type: INT,  w: 110, check: true, save: { table: 'person_anc', col: 'labor_place_id',          keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'btype',   label: 'วิธีคลอด',          type: INT,  w: 100, check: true, save: { table: 'person_anc', col: 'labour_type_id',          keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'bdoctor', label: 'ผู้ทำคลอด',         type: INT,  w: 100, check: true, save: { table: 'person_anc', col: 'labor_doctor_type_id',    keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'lborn',   label: 'เกิดมีชีพ',         type: INT,  w: 90,  check: true, save: { table: 'person_anc', col: 'alive_child_count',       keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'sborn',   label: 'ตายคลอด',           type: INT,  w: 90,  check: true, save: { table: 'person_anc', col: 'dead_child_count',        keyCol: 'person_anc_id', ctxKey: 'ancId' } },
      { key: 'cid',     label: 'เลขบัตร ปชช.',      type: TXT,  w: 140, check: true, save: { table: 'person',     col: 'cid',                    keyCol: 'person_id',     ctxKey: 'personId' } }
    ]
  },
  postnatal: {
    label: 'ดูแลหลังคลอด',
    dateCol: 'c.care_date',
    fields: [
      { key: 'ppcare',   label: 'วันที่ดูแลแม่',   type: DATE, w: 120, check: true, save: { table: 'person_anc_preg_care', col: 'care_date',       keyCol: 'person_anc_preg_care_id', ctxKey: 'careId' } },
      { key: 'ppresult', label: 'ตรวจมารดาหลัง',   type: TXT,  w: 110, check: true, save: { table: 'person_anc_preg_care', col: 'perineum_normal', keyCol: 'person_anc_preg_care_id', ctxKey: 'careId' } },
      { key: 'provider', label: 'ผู้ให้บริการ',    type: TXT,  w: 140, check: true, save: { table: 'person_anc_preg_care', col: 'doctor_code',     keyCol: 'person_anc_preg_care_id', ctxKey: 'careId' } },
      { key: 'cid',      label: 'เลขบัตร ปชช.',    type: TXT,  w: 140, check: true, save: { table: 'person',               col: 'cid',             keyCol: 'person_id',               ctxKey: 'personId' } }
    ]
  }
};

const modeOf = (m) => MODES[m] || MODES.prenatal;
const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
function fieldBlank(f, v) {
  if (isBlank(v)) return true;
  if (f.zeroBlank && (f.type === INT || f.type === FLOAT) && Number(v) === 0) return true;
  return false;
}

function toISO(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date && !isNaN(v)) return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
  const s = String(v); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const d = new Date(s); if (!isNaN(d)) return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  return s.slice(0, 10);
}

function metaOf(mode) {
  return modeOf(mode).fields.map((f) => ({
    key: f.key, label: f.label, type: f.type, w: f.w, check: f.check, editable: true,
    keyReq: f.save ? f.save.ctxKey : null
  }));
}

/** SELECT ต่อ mode — คืน row grain ตามแฟ้ม (ตัดซ้ำด้วย DISTINCT ON primary key) */
function baseSql(mode) {
  const nameExpr = "TRIM(COALESCE(p.pname,'') || COALESCE(p.fname,'') || ' ' || COALESCE(p.lname,''))";
  if (mode === 'all') {
    return [
      'SELECT',
      '  pa.person_anc_id AS anc_id, pa.person_id AS person_id, pa.anc_register_date AS rowdate,',
      '  pa.preg_no AS gravida, pa.lmp AS lmp, pa.edc AS edc,',
      '  pa.blood_vdrl1_result AS vdrl, pa.blood_hiv1_result AS hiv, pa.blood_hct_result AS hct,',
      '  pa.thalassaemia_result_id AS thalassemia, pa.anc_register_staff AS anc_provider, p.height_cm AS height,',
      '  pa.labor_date AS bdate, pa.labor_icd10 AS bresult, pa.labor_place_id AS bplace,',
      '  pa.labour_type_id AS btype, pa.labor_doctor_type_id AS bdoctor,',
      '  pa.alive_child_count AS lborn, pa.dead_child_count AS sborn,',
      '  p.cid AS cid, p.patient_hn AS hn, ' + nameExpr + ' AS ptname,',
      '  sv.person_anc_service_id AS svc_id, sv.vn AS vn, sv.anc_service_number AS ancno, sv.pa_week AS ga,',
      '  sv.service_result AS ancresult, o.bw AS weight, sv.anc_service_date AS anc_last_date,',
      '  COALESCE(sc.c, 0) AS anc_count,',
      '  ca.person_anc_preg_care_id AS care_id, ca.care_date AS ppcare, ca.perineum_normal AS ppresult, ca.doctor_code AS pp_provider',
      'FROM person_anc pa',
      'JOIN person p ON p.person_id = pa.person_id',
      'LEFT JOIN (',
      '  SELECT DISTINCT ON (person_anc_id) person_anc_id, person_anc_service_id, vn,',
      '         anc_service_number, pa_week, service_result, anc_service_date',
      '  FROM person_anc_service ORDER BY person_anc_id, anc_service_date DESC NULLS LAST, person_anc_service_id DESC',
      ') sv ON sv.person_anc_id = pa.person_anc_id',
      'LEFT JOIN (',
      '  SELECT DISTINCT ON (person_anc_id) person_anc_id, person_anc_preg_care_id, care_date, perineum_normal, doctor_code',
      '  FROM person_anc_preg_care ORDER BY person_anc_id, care_date DESC NULLS LAST, person_anc_preg_care_id DESC',
      ') ca ON ca.person_anc_id = pa.person_anc_id',
      'LEFT JOIN (SELECT person_anc_id, COUNT(*) AS c FROM person_anc_service GROUP BY person_anc_id) sc ON sc.person_anc_id = pa.person_anc_id',
      'LEFT JOIN opdscreen o ON o.vn = sv.vn'
    ].join('\n');
  }
  if (mode === 'anc') {
    return [
      'SELECT DISTINCT ON (s.person_anc_service_id)',
      '  s.person_anc_service_id AS svc_id, s.person_anc_id AS anc_id, pa.person_id AS person_id,',
      '  s.vn AS vn, s.anc_service_date AS rowdate,',
      '  s.anc_service_number AS ancno, s.pa_week AS ga, s.service_result AS ancresult, o.bw AS weight,',
      '  pa.preg_no AS gravida, p.cid AS cid, p.patient_hn AS hn, ' + nameExpr + ' AS ptname',
      'FROM person_anc_service s',
      'JOIN person_anc pa ON pa.person_anc_id = s.person_anc_id',
      'JOIN person p ON p.person_id = pa.person_id',
      'LEFT JOIN opdscreen o ON o.vn = s.vn'
    ].join('\n');
  }
  if (mode === 'postnatal') {
    return [
      'SELECT DISTINCT ON (c.person_anc_preg_care_id)',
      '  c.person_anc_preg_care_id AS care_id, c.person_anc_id AS anc_id, pa.person_id AS person_id,',
      '  c.vn AS vn, c.care_date AS rowdate,',
      '  c.care_date AS ppcare, c.perineum_normal AS ppresult, c.doctor_code AS provider,',
      '  pa.preg_no AS gravida, p.cid AS cid, p.patient_hn AS hn, ' + nameExpr + ' AS ptname',
      'FROM person_anc_preg_care c',
      'JOIN person_anc pa ON pa.person_anc_id = c.person_anc_id',
      'JOIN person p ON p.person_id = pa.person_id'
    ].join('\n');
  }
  // prenatal + labor : person_anc grain
  const dateCol = mode === 'labor' ? 'pa.labor_date' : 'pa.anc_register_date';
  return [
    'SELECT DISTINCT ON (pa.person_anc_id)',
    '  pa.person_anc_id AS anc_id, pa.person_id AS person_id,',
    '  ' + dateCol + ' AS rowdate,',
    '  pa.preg_no AS gravida, pa.lmp AS lmp, pa.edc AS edc,',
    '  pa.blood_vdrl1_result AS vdrl, pa.blood_hiv1_result AS hiv, pa.blood_hct_result AS hct,',
    '  pa.thalassaemia_result_id AS thalassemia, pa.anc_register_staff AS provider, p.height_cm AS height,',
    '  pa.labor_date AS bdate, pa.labor_icd10 AS bresult, pa.labor_place_id AS bplace,',
    '  pa.labour_type_id AS btype, pa.labor_doctor_type_id AS bdoctor,',
    '  pa.alive_child_count AS lborn, pa.dead_child_count AS sborn,',
    '  p.cid AS cid, p.patient_hn AS hn, ' + nameExpr + ' AS ptname',
    'FROM person_anc pa',
    'JOIN person p ON p.person_id = pa.person_id'
  ].join('\n');
}

async function ancList(cfg, mode, from, to, limit) {
  if (!MODES[mode]) mode = 'prenatal';
  const conf = MODES[mode];
  const where = [conf.dateCol + ' BETWEEN ?::date AND ?::date'];
  if (conf.onlyDelivered) where.push('pa.labor_date IS NOT NULL');
  const orderKey = mode === 'anc' ? 's.person_anc_service_id' : (mode === 'postnatal' ? 'c.person_anc_preg_care_id' : 'pa.person_anc_id');
  const sql = baseSql(mode) +
    '\nWHERE ' + where.join(' AND ') +
    '\nORDER BY ' + orderKey + ' DESC LIMIT ' + (Number(limit) || 20000);
  const rows = await db.query(cfg, sql, [from, to]);
  return rows.map((r) => decorate(mode, r));
}

function decorate(mode, r) {
  const conf = modeOf(mode);
  const out = Object.assign({}, r);
  // normalize dates
  ['rowdate', 'lmp', 'edc', 'bdate', 'ppcare', 'anc_last_date'].forEach((k) => { if (k in out) out[k] = toISO(out[k]); });
  out.vstdate = out.rowdate || '';
  const missing = conf.fields.filter((f) => f.check && fieldBlank(f, out[f.key])).map((f) => f.key);
  const checkN = conf.fields.filter((f) => f.check).length || 1;
  out._missing = missing;
  out._complete = missing.length === 0;
  out._percent = Math.round(((checkN - missing.length) / checkN) * 100);
  // key สำหรับ frontend: mode:primaryId
  out.key = mode + ':' + (mode === 'anc' ? out.svc_id : (mode === 'postnatal' ? out.care_id : out.anc_id));
  // ctx สำหรับ save
  out._ctx = { ancId: out.anc_id, personId: out.person_id, svcId: out.svc_id, careId: out.care_id, vn: out.vn, hn: out.hn };
  return out;
}

function summarizeAnc(mode, rows) {
  const conf = modeOf(mode);
  const total = rows.length;
  let complete = 0, scoreSum = 0;
  rows.forEach((r) => { if (r._complete) complete++; scoreSum += (r._percent || 0); });
  return {
    total, complete, incomplete: total - complete,
    percent: total ? Math.round(scoreSum / total) : 0,
    fields: conf.fields.filter((f) => f.check).length
  };
}

async function saveAncField(cfg, mode, field, ctx, value) {
  ctx = ctx || {};
  const conf = modeOf(mode);
  const f = conf.fields.find((x) => x.key === field);
  if (!f || !f.save) { const e = new Error('ฟิลด์นี้แก้ไขไม่ได้'); e.status = 400; throw e; }

  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (raw === '') { const e = new Error('กรุณากรอกค่า'); e.status = 400; throw e; }

  let val = raw;
  if (f.type === DATE) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) { const e = new Error('รูปแบบวันที่ต้องเป็น YYYY-MM-DD'); e.status = 400; throw e; }
  } else if (f.type === INT) {
    if (!/^-?\d+$/.test(raw)) { const e = new Error('ต้องเป็นจำนวนเต็ม'); e.status = 400; throw e; }
    val = parseInt(raw, 10);
  } else if (f.type === FLOAT) {
    if (!/^-?\d+(\.\d+)?$/.test(raw)) { const e = new Error('ต้องเป็นตัวเลข'); e.status = 400; throw e; }
    val = Number(raw);
  }

  const keyVal = ctx[f.save.ctxKey];
  if (keyVal === undefined || keyVal === null || String(keyVal).trim() === '') {
    const e = new Error('ไม่พบคีย์ต้นทาง (' + f.save.ctxKey + ')'); e.status = 400; throw e;
  }
  const r = await db.execute(cfg,
    'UPDATE ' + f.save.table + ' SET ' + f.save.col + ' = ? WHERE ' + f.save.keyCol + ' = ?', [val, keyVal]);
  if (!r.affected) { const e = new Error('ไม่พบระเบียนต้นทาง (' + f.save.table + ')'); e.status = 404; throw e; }
  return { affected: r.affected, value: val };
}

module.exports = { MODES, metaOf, ancList, summarizeAnc, saveAncField };
