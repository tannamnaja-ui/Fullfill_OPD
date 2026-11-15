'use strict';
/**
 * คำแนะนำการลงข้อมูลผู้ป่วยในเพื่อให้ DRG/RW สะท้อนการรักษาจริง (Clinical Documentation Improvement)
 *   - ลงเพิ่ม (add)    : หลักฐานในยา / lab / ค่าใช้จ่าย บ่งว่ามีโรคร่วมหรือหัตถการที่ยังไม่ได้ลงรหัส
 *   - เรียงลำดับ (order): Pdx / ประเภทการวินิจฉัย / ลำดับหัตถการ ไม่เหมาะสม
 *   - ตรวจทาน (check)  : รหัสซ้ำ รหัสไม่เจาะจง ยาที่ไม่มี Dx รองรับ
 * ทุกข้อเป็น "คำแนะนำ" — ต้องให้แพทย์/coder ยืนยันจากเวชระเบียนก่อนลง (ห้ามลงรหัสที่ไม่มีบันทึกรองรับ)
 */
const db = require('./db');

const s = (v) => (v === null || v === undefined ? '' : String(v).trim());
const n = (v) => Number(v) || 0;
const up = (v) => s(v).toUpperCase().replace(/\./g, '');
const DT = "TRIM(LEADING '0' FROM TRIM(d.diagtype))";
const CHUNK = 400;

/** ICD10 ไม่มีจุด (E119) / ICD9 มีจุด (9671 → 96.71) */
const fmt10 = (c) => up(c);   // ICD10 แสดงแบบไม่มีจุด เช่น E119
const fmt9 = (c) => { c = up(c); return c.length > 2 ? c.slice(0, 2) + '.' + c.slice(2) : c; };

/** ช่วงรหัส ICD10 เช่น 'E10-E14', 'I10-I15', 'N39.0' */
function inRange(code, spec) {
  code = up(code);
  return spec.split(',').some((part) => {
    part = up(part.trim());
    if (part.indexOf('-') < 0) return code.indexOf(part) === 0;
    const [a, b] = part.split('-');
    const k = code.slice(0, a.length);
    return k >= a && k <= b;
  });
}
const anyDx = (dx, spec) => dx.some((d) => inRange(d.icd10, spec));

/* ---------- กลุ่มยา (ชื่อการค้า/สามัญ) → โรคร่วมที่ควรมี ---------- */
const DRUG_RULES = [
  { re: /insulin|actrapid|mixtard|humulin|novomix|novorapid|lantus|glargine|metformin|glipizide|gliclazide|glibenclamide|glimepiride|pioglitazone|sitagliptin|vildagliptin|linagliptin|empagliflozin|dapagliflozin/i,
    need: 'E10-E14', code: 'E119', label: 'เบาหวาน' },
  { re: /amlodipine|enalapril|losartan|nifedipine|hydralazine|valsartan|lisinopril|manidipine|felodipine|hydrochlorothiazide|\bhctz\b|irbesartan|telmisartan|candesartan|ramipril|captopril/i,
    need: 'I10-I15', code: 'I10', label: 'ความดันโลหิตสูง', skipIf: 'O10-O16,O60' },   // nifedipine/hydralazine ในครรภ์เป็นข้อบ่งชี้อื่น
  { re: /simvastatin|atorvastatin|rosuvastatin|pravastatin|gemfibrozil|fenofibrate|ezetimibe/i,
    need: 'E78', code: 'E785', label: 'ไขมันในเลือดผิดปกติ' },
  { re: /levothyroxine|euthyrox|eltroxin/i, need: 'E00-E03,E89', code: 'E039', label: 'ภาวะไทรอยด์ต่ำ' },
  { re: /methimazole|propylthiouracil|\bptu\b/i, need: 'E05', code: 'E059', label: 'ภาวะไทรอยด์เป็นพิษ' },
  { re: /potassium chloride|\bkcl\b|elixir\s*k|kalium/i, need: 'E876', code: 'E876', label: 'โพแทสเซียมต่ำ (ได้ KCl)' },
  { re: /isoniazid|rifampicin|pyrazinamide|ethambutol/i, need: 'A15-A19', label: 'วัณโรค (ได้ยาต้านวัณโรค)' },
  { re: /efavirenz|dolutegravir|lopinavir|zidovudine|nevirapine|rilpivirine/i, need: 'B20-B24,Z21', label: 'HIV (ได้ยาต้านไวรัส)' },
  { re: /warfarin|orfarin/i, need: 'I48,I26,I80-I82,Z95,Z921,Z7901', label: 'ข้อบ่งชี้ยาต้านการแข็งตัวของเลือด (เช่น AF I48 / Z92.1)' },
  { re: /phenytoin|dilantin|levetiracetam|keppra|valpro|depakin|carbamazepine|phenobarbital|lamotrigine|topiramate/i,
    need: 'G40-G41,R56', label: 'ลมชัก/ชัก (ได้ยากันชัก)' },
  { re: /budesonide|ipratropium|berodual|seretide|symbicort|tiotropium|fluticasone.*salmeterol|spiriva/i,
    need: 'J44-J46', label: 'COPD / หอบหืด (ได้ยาพ่น)' }
];
// ยาปฏิชีวนะที่ใช้รักษาการติดเชื้อ (ไม่รวม cefazolin ที่มักใช้ป้องกันก่อนผ่าตัด)
const ANTIBIOTIC = /ceftriaxone|meropenem|imipenem|ertapenem|piperacillin|tazocin|vancomycin|ceftazidime|cefepime|cefotaxime|ampicillin|gentamicin|amikacin|colistin|clindamycin|levofloxacin|ciprofloxacin|metronidazole|azithromycin|doxycycline|amoxicillin|augmentin|cloxacillin|dicloxacillin|penicillin|cefdinir|cefixime|cotrimoxazole|bactrim/i;
const INFECTION_DX = 'A00-B99,J00-J22,J36,J39,J85-J86,K35-K37,K57,K61,K63,K65,K67,K75,K80,K81,K83,L00-L08,M00,M46,M86,N10,N12,N13,N15,N30,N34,N39,N41,N45,N70-N77,O23,O41,O75,O85,O86,O91,O98,P23,P36-P39,G00-G07,H00,H05,H10,H60,H65-H67,H70,I30,I33,T80,T81,T82,T83,T84,T85,T88,R50,R65,U07,Z22';

/* ---------- ค่าใช้จ่ายที่ชื่อไม่ตรง icd9cm1 → รหัส ICD9 ที่ควรลง ---------- */
const CHARGE_RULES = [
  { re: /intubation|ใส่ท่อหลอดลม|endotracheal/i, icd9: ['9604'] },
  { re: /bipap|cpap|non\s*invasive/i, icd9: ['9390'] },
  { re: /respirator|ventilat|เครื่องช่วยหายใจ/i, vent: true },
  { re: /ฟอกเลือด|hemodialysis|haemodialysis/i, icd9: ['3995'] },
  { re: /คลอดปกติ/i, icd9: ['7359'] },
  { re: /เย็บแผล/i, icd9: ['8659'] },
  { re: /\b(ld\.?\s*|l)?prc\b|packed red|whole blood/i, icd9: ['9904'], blood: true },
  { re: /\bffp\b|fresh frozen|plasma/i, icd9: ['9907'] },
  { re: /\b(lppc|ldppc|ldp|pc)\b|platelet/i, icd9: ['9905'] },
  { re: /cryo/i, icd9: ['9906'] }
];
const NOT_PROC = /cross\s*match|antibody|ตรวจปฏิบัติการ|จัดหาโลหิต|เปลี่ยนสาย|ชุดเครื่อง|n95|respirator 18|cartridge|sars|coronavirus|pcr/i;
const VENT_CODES = ['9670', '9671', '9672'];

/* ---------- lab ที่ใช้ ---------- */
const LAB_CLASS = [
  { key: 'k', re: /potassium|^k\s*\+?\s*(\(|$)/i },
  { key: 'na', re: /sodium|^na\s*\+?\s*(\(|$)/i },
  { key: 'hb', re: /^(hemoglobin|haemoglobin)\s*\(hb\)|^hb\.?$|^hgb\.?$/i },
  { key: 'cr', re: /creatinine/i },
  { key: 'alb', re: /^(serum\s+)?albumin\.?$/i },
  { key: 'a1c', re: /a1c/i },
  { key: 'fbs', re: /^fbs\b|fasting blood sugar/i }
];
const LAB_EXCLUDE = /urine|24\s*h|dialysate|fluid|csf|clearance|ratio|type|micro|poct|stool|body|pleural|ascit/i;

/* ---------- แคชตารางอ้างอิง (ต่อฐานข้อมูล) ---------- */
const cache = new Map();
function cacheKey(cfg) { return JSON.stringify([cfg && cfg.db && cfg.db.host, cfg && cfg.db && cfg.db.database, cfg && cfg.mode]); }
async function refs(cfg) {
  const k = cacheKey(cfg);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 3600e3) return hit;
  const out = { at: Date.now(), chargeIcd9: new Map(), lab: new Map(), icd9Name: new Map(), icd10Name: new Map() };
  // รายการค่าใช้จ่ายที่ชื่อตรงกับชื่อหัตถการ ICD9
  try {
    const rows = await db.query(cfg,
      "SELECT n.icode, c.code, c.name FROM nondrugitems n JOIN icd9cm1 c ON UPPER(c.name) = UPPER(TRIM(TRAILING '.' FROM TRIM(REPLACE(n.name, '[N]', ''))))", []);
    rows.forEach((r) => {
      const a = out.chargeIcd9.get(s(r.icode)) || [];
      a.push(up(r.code)); out.chargeIcd9.set(s(r.icode), a);
      out.icd9Name.set(up(r.code), s(r.name));
    });
  } catch (e) { /* ไม่มีตาราง */ }
  try {
    const rows = await db.query(cfg, 'SELECT lab_items_code, lab_items_name, lab_items_unit FROM lab_items', []);
    rows.forEach((r) => {
      const nm = s(r.lab_items_name);
      if (!nm) return;
      const cls = LAB_CLASS.find((c) => c.re.test(nm) && (c.key === 'a1c' || !LAB_EXCLUDE.test(nm)));
      if (!cls) return;
      if (cls.key === 'hb' && /mmol/i.test(s(r.lab_items_unit))) return;
      out.lab.set(String(r.lab_items_code), cls.key);
    });
  } catch (e) { /* ไม่มีตาราง lab */ }
  // ชื่อรหัสที่ใช้แนะนำ
  const want10 = new Set(['E119', 'I10', 'E785', 'E039', 'E059', 'E876', 'E875', 'E871', 'E870', 'D649', 'D62', 'N179', 'E46', 'E880', 'J960']);
  const want9 = new Set(['9604', '9390', '3995', '7359', '8659', '9904', '9905', '9906', '9907', '9671', '9672']);
  try {
    const r10 = await db.query(cfg, 'SELECT code, name FROM icd101 WHERE code IN (' + [...want10].map(() => '?').join(',') + ')', [...want10]);
    r10.forEach((r) => out.icd10Name.set(up(r.code), s(r.name)));
    const r9 = await db.query(cfg, 'SELECT code, name FROM icd9cm1 WHERE code IN (' + [...want9].map(() => '?').join(',') + ')', [...want9]);
    r9.forEach((r) => out.icd9Name.set(up(r.code), s(r.name)));
  } catch (e) { /* ข้าม */ }
  cache.set(k, out);
  return out;
}

/* ---------- ดึงข้อมูลแบบกลุ่ม (ทีละ CHUNK AN) ---------- */
async function inChunks(list, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(...(await fn(list.slice(i, i + CHUNK))));
  return out;
}
const ph = (a) => a.map(() => '?').join(',');
function groupBy(rows, key) {
  const m = new Map();
  rows.forEach((r) => { const k = s(r[key]); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return m;
}

async function gather(cfg, rows) {
  const ans = rows.map((r) => s(r.an)).filter(Boolean);
  const vnOf = new Map(rows.map((r) => [s(r.vn), s(r.an)]).filter((x) => x[0]));
  if (!ans.length) return { dx: new Map(), proc: new Map(), items: new Map(), lab: new Map() };
  const R = await refs(cfg);

  const dx = await inChunks(ans, (c) => db.query(cfg,
    'SELECT d.an, d.ipt_diag_id AS id, ' + DT + ' AS diagtype, d.icd10 FROM iptdiag d WHERE d.an IN (' + ph(c) + ') ORDER BY d.an, ' + DT + ', d.ipt_diag_id', c));
  const proc = await inChunks(ans, (c) => db.query(cfg,
    'SELECT o.an, o.iptoprt_id AS id, o.icd9, o.opdate, o.optime, o.priority FROM iptoprt o WHERE o.an IN (' + ph(c) + ') ORDER BY o.an, o.opdate, o.optime, o.iptoprt_id', c));
  const items = await inChunks(ans, (c) => db.query(cfg, [
    'SELECT r.an, r.icode, MAX(r.income) AS income, MIN(r.rxdate) AS first_date, SUM(r.qty) AS qty, COUNT(*) AS cnt,',
    '  MAX(COALESCE(di.name, nd.name)) AS name, MAX(di.generic_name) AS generic, MAX(CASE WHEN di.icode IS NULL THEN 0 ELSE 1 END) AS is_drug',
    'FROM opitemrece r LEFT JOIN drugitems di ON di.icode = r.icode LEFT JOIN nondrugitems nd ON nd.icode = r.icode',
    'WHERE r.an IN (' + ph(c) + ') GROUP BY r.an, r.icode'
  ].join('\n'), c));

  let lab = [];
  const labCodes = [...R.lab.keys()];
  if (labCodes.length) {
    const keys = ans.concat([...vnOf.keys()]);
    lab = await inChunks(keys, (c) => db.query(cfg, [
      'SELECT h.vn, o.lab_items_code, o.lab_order_result AS res',
      'FROM lab_head h JOIN lab_order o ON o.lab_order_number = h.lab_order_number',
      'WHERE h.vn IN (' + ph(c) + ') AND o.lab_items_code IN (' + ph(labCodes) + ')'
    ].join('\n'), c.concat(labCodes))).catch(() => []);
  }
  // สรุป lab ต่อ AN: ค่าต่ำสุด/สูงสุด ของแต่ละกลุ่ม
  const labBy = new Map();
  lab.forEach((r) => {
    const an = ans.indexOf(s(r.vn)) >= 0 ? s(r.vn) : vnOf.get(s(r.vn));
    const key = R.lab.get(String(r.lab_items_code));
    const v = parseFloat(String(r.res || '').replace(/[^\d.]/g, ''));
    if (!an || !key || !isFinite(v) || v <= 0) return;
    const m = labBy.get(an) || {};
    const x = m[key] || { min: v, max: v, n: 0 };
    x.min = Math.min(x.min, v); x.max = Math.max(x.max, v); x.n++;
    m[key] = x; labBy.set(an, m);
  });
  return { dx: groupBy(dx, 'an'), proc: groupBy(proc, 'an'), items: groupBy(items, 'an'), lab: labBy, R };
}

/* ---------- กฎคำแนะนำของผู้ป่วย 1 ราย ---------- */
const isMajorProc = (code) => { const c = up(code); const k = parseInt(c.slice(0, 2), 10); return c.length >= 2 && k >= 1 && k <= 86; };
const isExt = (code) => /^[V-Y]/.test(up(code));
const isSymptom = (code) => /^R/.test(up(code));
// รหัสที่มักเป็นโรคประจำตัว/ประวัติ ไม่น่าเป็นเหตุผลหลักของการ admit
const CHRONIC_PDX = 'I10,E78,E119,E149,E109,E039,Z86,Z87,Z88,Z92,Z95,Z99';

function adviseOne(row, g) {
  const R = g.R || { icd9Name: new Map(), icd10Name: new Map(), chargeIcd9: new Map() };
  const an = s(row.an);
  const dx = (g.dx.get(an) || []).map((d) => ({ id: d.id, type: s(d.diagtype), icd10: up(d.icd10) }));
  const proc = (g.proc.get(an) || []).map((p) => ({ id: p.id, icd9: up(p.icd9), opdate: p.opdate, priority: p.priority }));
  const items = g.items.get(an) || [];
  const lab = g.lab.get(an) || {};
  const out = [];
  const add = (a) => {
    if (out.some((x) => x.key === a.key)) return;
    // รหัสที่แนะนำซ้ำกัน (เช่น E87.6 จากยา KCl และจาก K ต่ำ) → รวมหลักฐานไว้ข้อเดียว
    const sameCode = a.action && out.find((x) => x.action && x.action.type === a.action.type &&
      (x.action.icd10 || x.action.icd9) === (a.action.icd10 || a.action.icd9));
    if (sameCode) { sameCode.text += ' · และ ' + a.text.split(' — ')[0]; return; }
    out.push(a);
  };
  const name10 = (c) => R.icd10Name.get(up(c)) || '';
  const name9 = (c) => R.icd9Name.get(up(c)) || '';
  const pdx = dx.filter((d) => d.type === '1');
  const others = dx.filter((d) => d.type !== '1');
  const codes = dx.map((d) => d.icd10);

  /* ===== ICD10: Pdx และลำดับ ===== */
  if (!dx.length) {
    add({ key: 'nodx', kind: 'add', area: 'dx', text: 'ยังไม่มีการวินิจฉัย — ลง Pdx (โรคที่เป็นเหตุผลหลักของการ admit) และโรคร่วม/โรคแทรกซ้อน' });
  } else if (!pdx.length) {
    const cand = others.find((d) => !isExt(d.icd10) && !isSymptom(d.icd10) && !/^Z/.test(d.icd10)) || others.find((d) => !isExt(d.icd10));
    add({ key: 'nopdx', kind: 'order', area: 'dx',
      text: 'ยังไม่มี Pdx (ประเภท 1) — DRG จะ group ไม่ได้' + (cand ? ' · เสนอให้ ' + fmt10(cand.icd10) + ' เป็น Pdx ถ้าเป็นเหตุผลหลักของการ admit' : ''),
      action: cand ? { type: 'settype', id: cand.id, diagtype: '1', label: 'ตั้ง ' + fmt10(cand.icd10) + ' เป็น Pdx' } : null });
  }
  if (pdx.length > 1) {
    add({ key: 'pdx2', kind: 'order', area: 'dx', text: 'มี Pdx ' + pdx.length + ' รายการ (' + pdx.map((d) => fmt10(d.icd10)).join(', ') + ') — ต้องมี Pdx เพียง 1 รายการ ที่เหลือเปลี่ยนเป็นโรคร่วม (2)' });
  }
  const p = pdx[0];
  if (p) {
    const definitive = others.filter((d) => !isExt(d.icd10) && !isSymptom(d.icd10) && !/^Z/.test(d.icd10));
    if (isExt(p.icd10)) {
      const inj = others.find((d) => /^[ST]/.test(d.icd10));
      add({ key: 'pdxext', kind: 'order', area: 'dx', text: 'Pdx ' + fmt10(p.icd10) + ' เป็นรหัสสาเหตุภายนอก (V–Y) ใช้เป็น Pdx ไม่ได้ — ให้ใช้รหัสการบาดเจ็บ (S/T) เป็น Pdx และย้าย V–Y เป็นประเภท 5',
        action: inj ? { type: 'swap', id: inj.id, oldId: p.id, oldType: '5', label: 'สลับ: ' + fmt10(inj.icd10) + ' เป็น Pdx' } : null });
    } else if (isSymptom(p.icd10) && definitive.length) {
      add({ key: 'pdxsym', kind: 'order', area: 'dx',
        text: 'Pdx ' + fmt10(p.icd10) + ' เป็นรหัสอาการ (R) แต่มีโรคที่วินิจฉัยได้แล้ว ' + fmt10(definitive[0].icd10) + ' — ถ้าอาการนี้เกิดจากโรคดังกล่าว ให้ใช้โรคเป็น Pdx (มักได้ RW สูงกว่า)',
        action: { type: 'swap', id: definitive[0].id, oldId: p.id, oldType: '2', label: 'สลับ: ' + fmt10(definitive[0].icd10) + ' เป็น Pdx' } });
    } else if (inRange(p.icd10, CHRONIC_PDX)) {
      const acute = definitive.find((d) => !inRange(d.icd10, CHRONIC_PDX + ',E10-E14,I25,N18'));
      if (acute) add({ key: 'pdxchronic', kind: 'order', area: 'dx',
        text: 'Pdx ' + fmt10(p.icd10) + ' เป็นโรคประจำตัว แต่มี ' + fmt10(acute.icd10) + ' ' + name10(acute.icd10) + ' ซึ่งน่าจะเป็นเหตุผลหลักของการ admit — ทบทวนการเลือก Pdx',
        action: { type: 'swap', id: acute.id, oldId: p.id, oldType: '2', label: 'สลับ: ' + fmt10(acute.icd10) + ' เป็น Pdx' } });
    }
    if (/9$/.test(p.icd10) && p.icd10.length === 4) {
      add({ key: 'pdxunsp', kind: 'check', area: 'dx', text: 'Pdx ' + fmt10(p.icd10) + ' เป็นรหัสไม่เจาะจง (ลงท้าย 9) — ถ้าเวชระเบียนระบุชนิด/ตำแหน่ง/เชื้อได้ ให้ใช้รหัสที่เจาะจงกว่า' });
    }
  }
  // ประเภทการวินิจฉัย: V–Y ต้องเป็นประเภท 5, รหัสอื่นไม่ควรเป็น 5
  dx.forEach((d) => {
    if (d.type === '1') return;
    if (isExt(d.icd10) && d.type !== '5') add({ key: 'ext5_' + d.id, kind: 'order', area: 'dx', text: fmt10(d.icd10) + ' เป็นสาเหตุภายนอก ควรเป็นประเภท 5 (External cause)', action: { type: 'settype', id: d.id, diagtype: '5', label: 'เปลี่ยนเป็นประเภท 5' } });
    if (!isExt(d.icd10) && d.type === '5') add({ key: 'not5_' + d.id, kind: 'order', area: 'dx', text: fmt10(d.icd10) + ' ไม่ใช่สาเหตุภายนอก แต่ลงเป็นประเภท 5 — ควรเป็นโรคร่วม (2) หรือโรคแทรกซ้อน (3)', action: { type: 'settype', id: d.id, diagtype: '2', label: 'เปลี่ยนเป็นประเภท 2' } });
  });
  // รหัสซ้ำ / รหัสไม่เจาะจงซ้ำกับรหัสเจาะจงในหมวดเดียวกัน
  const seen = {};
  dx.forEach((d) => { seen[d.icd10] = (seen[d.icd10] || 0) + 1; });
  Object.keys(seen).filter((c) => seen[c] > 1).forEach((c) => add({ key: 'dup_' + c, kind: 'check', area: 'dx', text: 'ลง ' + fmt10(c) + ' ซ้ำ ' + seen[c] + ' ครั้ง — ลบรายการที่ซ้ำ' }));
  dx.forEach((d) => {
    if (d.icd10.length !== 4 || !/9$/.test(d.icd10)) return;
    const spec = dx.find((x) => x !== d && x.icd10.slice(0, 3) === d.icd10.slice(0, 3) && x.icd10 !== d.icd10);
    if (spec) add({ key: 'unsp_' + d.id, kind: 'check', area: 'dx', text: fmt10(d.icd10) + ' (ไม่เจาะจง) ซ้ำหมวดกับ ' + fmt10(spec.icd10) + ' — ควรเหลือเฉพาะรหัสที่เจาะจง' });
  });
  // บาดเจ็บ S/T ต้องมีสาเหตุภายนอก
  if (anyDx(dx, 'S00-T98') && !anyDx(dx, 'V01-Y98')) {
    add({ key: 'noext', kind: 'add', area: 'dx', text: 'มีรหัสการบาดเจ็บ/พิษ (S/T) แต่ยังไม่มีสาเหตุภายนอก (V01–Y98) — ลงเป็นประเภท 5' });
  }

  /* ===== โรคร่วมจากยา ===== */
  const drugs = items.filter((x) => n(x.is_drug));
  const nonDrug = items.filter((x) => !n(x.is_drug));
  DRUG_RULES.forEach((rule, i) => {
    const hit = drugs.filter((x) => rule.re.test(s(x.name) + ' ' + s(x.generic)));
    if (!hit.length || anyDx(dx, rule.need) || (rule.skipIf && anyDx(dx, rule.skipIf))) return;
    add({ key: 'drug' + i, kind: rule.code ? 'add' : 'check', area: 'dx',
      text: 'ได้ยา ' + hit.slice(0, 3).map((x) => s(x.name)).join(', ') + (hit.length > 3 ? ' …' : '') + ' แต่ไม่มี Dx ' + rule.label +
        (rule.code ? ' — ถ้าแพทย์บันทึกไว้ ลง ' + fmt10(rule.code) + ' (หรือรหัสที่เจาะจงกว่า) เป็นโรคร่วม' : ' — ทบทวนเวชระเบียน'),
      action: rule.code ? { type: 'adddx', icd10: rule.code, diagtype: '2', label: 'เพิ่ม ' + fmt10(rule.code) } : null });
  });
  const abx = drugs.filter((x) => ANTIBIOTIC.test(s(x.name) + ' ' + s(x.generic)));
  if (abx.length && !anyDx(dx, INFECTION_DX)) {
    add({ key: 'abx', kind: 'check', area: 'dx', text: 'ได้ยาปฏิชีวนะ ' + abx.slice(0, 3).map((x) => s(x.name)).join(', ') + ' แต่ไม่มี Dx การติดเชื้อ — ทบทวนว่ามีการติดเชื้อที่ควรลงรหัสหรือไม่ (เช่น ปอดอักเสบ, UTI, sepsis)' });
  }

  /* ===== โรคร่วมจาก lab ===== */
  const L = (k) => lab[k];
  const labAdd = (key, cond, need, code, text) => {
    if (!cond || anyDx(dx, need)) return;
    add({ key, kind: 'add', area: 'dx', text: text + ' — ถ้าแพทย์วินิจฉัยไว้ ลง ' + fmt10(code) + ' เป็นโรคร่วม', action: { type: 'adddx', icd10: code, diagtype: '2', label: 'เพิ่ม ' + fmt10(code) } });
  };
  if (L('k')) {
    labAdd('k_lo', L('k').min < 3.3 && !anyDx(dx, 'E876'), 'E876', 'E876', 'K ต่ำสุด ' + L('k').min + ' mmol/L (ภาวะโพแทสเซียมต่ำ)');
    labAdd('k_hi', L('k').max > 5.5, 'E875', 'E875', 'K สูงสุด ' + L('k').max + ' mmol/L (ภาวะโพแทสเซียมสูง)');
  }
  if (L('na')) {
    labAdd('na_lo', L('na').min < 130, 'E871', 'E871', 'Na ต่ำสุด ' + L('na').min + ' mmol/L (ภาวะโซเดียมต่ำ)');
    labAdd('na_hi', L('na').max > 150, 'E870', 'E870', 'Na สูงสุด ' + L('na').max + ' mmol/L (ภาวะโซเดียมสูง)');
  }
  const newborn = row._age_days !== null && row._age_days !== undefined && row._age_days < 28;
  const transfused = nonDrug.some((x) => /\b(ld\.?\s*|l)?prc\b|packed red|whole blood/i.test(s(x.name)) && !NOT_PROC.test(s(x.name)));
  if (!newborn && !anyDx(dx, 'D50-D64,O99.0,O990')) {
    if (transfused) add({ key: 'anemia_tx', kind: 'add', area: 'dx', text: 'ได้รับเลือด (PRC) แต่ไม่มี Dx ภาวะซีด — ถ้าเสียเลือดเฉียบพลันลง D62 ถ้าไม่ใช่ลง D64.9 (หรือรหัสที่เจาะจงกว่า)', action: { type: 'adddx', icd10: 'D62', diagtype: '2', label: 'เพิ่ม D62' } });
    else if (L('hb') && L('hb').min < 10) labAdd('anemia', true, 'D50-D64', 'D649', 'Hb ต่ำสุด ' + L('hb').min + ' g/dL (ภาวะซีด)');
  }
  if (L('cr') && L('cr').max >= 1.5 && !anyDx(dx, 'N17-N19,O904,O90.4')) {
    const rise = L('cr').n > 1 && (L('cr').max - L('cr').min) >= 0.3;
    add({ key: 'cr', kind: 'add', area: 'dx', text: 'Creatinine สูงสุด ' + L('cr').max + ' mg/dL' + (rise ? ' (เปลี่ยนแปลง ≥ 0.3 ในการ admit นี้ → เข้าได้กับ AKI N17.9)' : '') + ' แต่ไม่มี Dx ไตวาย — ทบทวน AKI (N17) หรือ CKD (N18)',
      action: rise ? { type: 'adddx', icd10: 'N179', diagtype: '2', label: 'เพิ่ม N17.9' } : null });
  }
  if (L('alb') && L('alb').min < 3.0 && !anyDx(dx, 'E40-E46,E880')) {
    add({ key: 'alb', kind: 'add', area: 'dx', text: 'Albumin ต่ำสุด ' + L('alb').min + ' g/dL — ถ้าแพทย์ประเมินภาวะทุพโภชนาการไว้ ลง E43–E46 หรือ hypoalbuminemia E88.0' });
  }
  if (((L('a1c') && L('a1c').max >= 6.5) || (L('fbs') && L('fbs').max >= 126)) && !anyDx(dx, 'E10-E14,O24,R73')) {
    add({ key: 'dmlab', kind: 'add', area: 'dx', text: (L('a1c') && L('a1c').max >= 6.5 ? 'HbA1c ' + L('a1c').max + '%' : 'FBS ' + L('fbs').max + ' mg/dL') + ' เข้าเกณฑ์เบาหวาน แต่ไม่มี Dx เบาหวาน — ทบทวน E11',
      action: { type: 'adddx', icd10: 'E119', diagtype: '2', label: 'เพิ่ม E11.9' } });
  }

  /* ===== ICD9 จากค่าใช้จ่ายที่ยังไม่ได้ลงหัตถการ ===== */
  const have9 = new Set(proc.map((x) => x.icd9));
  const sugg9 = new Map();   // icd9 → { from: [ชื่อรายการ], date }
  const push9 = (code, it) => {
    if (!code || have9.has(code)) return;
    const x = sugg9.get(code) || { from: [], date: null };
    if (x.from.indexOf(s(it.name)) < 0) x.from.push(s(it.name));
    const d = it.first_date ? String(it.first_date instanceof Date ? isoDate(it.first_date) : it.first_date).slice(0, 10) : null;
    if (d && (!x.date || d < x.date)) x.date = d;
    sugg9.set(code, x);
  };
  let ventHours = 0, ventItem = null;
  nonDrug.forEach((it) => {
    const nm = s(it.name);
    if (NOT_PROC.test(nm)) return;
    const mapped = R.chargeIcd9.get(s(it.icode));
    if (mapped && mapped.length) { if (!mapped.some((c) => have9.has(c))) push9(mapped[mapped.length - 1], it); return; }
    const m = nm.match(/\((\d{2})\.(\d{1,2})\)/);
    if (m) { push9(m[1] + m[2], it); return; }
    const rule = CHARGE_RULES.find((r) => r.re.test(nm));
    if (!rule) return;
    if (rule.vent) {
      if (/bipap|cpap|non\s*invasive/i.test(nm)) return;
      ventItem = ventItem || it;
      ventHours += /ชม/.test(nm) && !/วัน/.test(nm) ? n(it.qty) * 8 : n(it.qty) * 24;
      return;
    }
    rule.icd9.forEach((c) => push9(c, it));
  });
  if (ventItem && !VENT_CODES.some((c) => have9.has(c))) {
    push9(ventHours >= 96 ? '9672' : '9671', Object.assign({}, ventItem, { name: s(ventItem.name) + ' ≈ ' + Math.round(ventHours) + ' ชม.' }));
    if (!anyDx(dx, 'J96,J80,P22,P28')) add({ key: 'vent_dx', kind: 'add', area: 'dx', text: 'ใช้เครื่องช่วยหายใจ แต่ไม่มี Dx ภาวะหายใจล้มเหลว — ถ้าแพทย์วินิจฉัยไว้ ลง J96.0 (ผู้ใหญ่) เป็นโรคร่วม',
      action: newborn ? null : { type: 'adddx', icd10: 'J960', diagtype: '2', label: 'เพิ่ม J96.0' } });
  }
  sugg9.forEach((x, code) => {
    add({ key: 'px_' + code, kind: 'add', area: 'proc',
      text: 'มีค่าใช้จ่าย "' + x.from.slice(0, 2).join('", "') + '" แต่ยังไม่ได้ลงหัตถการ ' + fmt9(code) + ' ' + name9(code),
      action: { type: 'addproc', icd9: code, opdate: x.date || row.regdate, label: 'เพิ่ม ' + fmt9(code) } });
  });
  // ใส่เครื่องช่วยหายใจแบบไม่ระบุชั่วโมง
  if (have9.has('9670')) add({ key: 'vent70', kind: 'check', area: 'proc', text: 'ลง 96.70 (ไม่ระบุระยะเวลา) — ให้ระบุ 96.71 (< 96 ชม.) หรือ 96.72 (≥ 96 ชม.) ซึ่งให้ RW ต่างกันมาก' });
  // หัตถการซ้ำวันเดียวกัน
  const pk = {};
  proc.forEach((x) => { const k = x.icd9 + '|' + String(x.opdate || '').slice(0, 10); pk[k] = (pk[k] || 0) + 1; });
  Object.keys(pk).filter((k) => pk[k] > 1).forEach((k) => add({ key: 'pxdup_' + k, kind: 'check', area: 'proc', text: 'ลงหัตถการ ' + fmt9(k.split('|')[0]) + ' ซ้ำ ' + pk[k] + ' ครั้งในวันเดียวกัน — ตรวจว่าทำจริงหลายครั้งหรือลงซ้ำ' }));
  // ลำดับหัตถการ: หัตถการหลัก (ผ่าตัด 01–86) ควรอยู่ก่อนหัตถการรอง (87–99)
  if (proc.length > 1 && !isMajorProc(proc[0].icd9) && proc.some((x) => isMajorProc(x.icd9))) {
    const m = proc.find((x) => isMajorProc(x.icd9));
    add({ key: 'pxorder', kind: 'order', area: 'proc', text: 'หัตถการลำดับแรกเป็น ' + fmt9(proc[0].icd9) + ' (หัตถการรอง/วินิจฉัย) — หัตถการหลัก/ผ่าตัด ' + fmt9(m.icd9) + ' ควรอยู่ลำดับแรก' });
  }

  /* ===== ข้อมูลอื่นที่มีผลต่อ DRG ===== */
  if (newborn && n(row.bw) <= 0) add({ key: 'nbw', kind: 'add', area: 'data', text: 'ทารกอายุ ' + row._age_days + ' วัน ยังไม่ได้ลงน้ำหนักแรกรับ — น้ำหนักทารกใช้แบ่งกลุ่ม DRG ทารกแรกเกิดโดยตรง' });

  // ICD10 ในข้อความแสดงแบบไม่มีจุด (D64.9 → D649) — ICD9 (ตัวเลขล้วน) คงจุดไว้
  const noDot = (t) => String(t || '').replace(/\b([A-Z]\d\d)\.(\d+)/g, '$1$2');
  out.forEach((a) => { a.text = noDot(a.text); if (a.action && a.action.label) a.action.label = noDot(a.action.label); });
  const ORDER = { order: 0, add: 1, check: 2 };
  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

function isoDate(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

/** ใส่ r._advice (รายการ) และ r.advice_n ให้ทุกแถว */
async function annotate(cfg, rows) {
  if (!rows.length) return rows;
  let g;
  try { g = await gather(cfg, rows); } catch (e) {
    console.warn('[ipdadvice]', e.message);
    rows.forEach((r) => { r._advice = []; r.advice_n = 0; });
    return rows;
  }
  rows.forEach((r) => {
    try { r._advice = adviseOne(r, g); } catch (e) { r._advice = []; }
    r.advice_n = r._advice.length;
  });
  return rows;
}

/** ลำดับ ICD10 / ICD9 ที่แนะนำ (ใช้ในหน้าต่างรายละเอียด) */
function suggestedOrder(dxItems, procItems) {
  const TYPE_RANK = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6 };
  const dx = dxItems.map((d) => {
    let t = s(d.diagtype);
    if (isExt(d.icd10)) t = '5';
    return Object.assign({}, d, { suggest_type: t });
  });
  // ถ้า Pdx เป็นรหัส V–Y ให้รหัส S/T แรกเป็น Pdx
  if (dx.some((d) => s(d.diagtype) === '1' && isExt(d.icd10))) {
    const inj = dx.find((d) => /^[ST]/.test(up(d.icd10)));
    if (inj) inj.suggest_type = '1';
  }
  dx.sort((a, b) => (TYPE_RANK[a.suggest_type] - TYPE_RANK[b.suggest_type]) || 0);
  const proc = procItems.slice().sort((a, b) =>
    (isMajorProc(b.icd9) - isMajorProc(a.icd9)) || String(a.opdate || '').localeCompare(String(b.opdate || '')));
  return { dx, proc: proc.map((p) => Object.assign({}, p, { major: isMajorProc(p.icd9) })) };
}

module.exports = { annotate, suggestedOrder, fmt10, fmt9 };
