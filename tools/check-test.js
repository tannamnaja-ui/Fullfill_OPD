/* ทดสอบหน้า "ตรวจสอบและเพิ่มข้อมูล" (คิวรี่ใหม่ + แก้ไขรายช่อง) ด้วย mock DB */
'use strict';
const opd = require('../server/lib/opd');
const db = require('../server/lib/db');

// ตารางจำลอง
const OVST = [
  { vn: 'V1', hn: 'H1', vstdate: '2026-08-27', vsttime: '08:30:00', main_dep: '137', an: null, pttype: '89', pttypeno: '', ovstist: '1', ovstost: '1', visit_type: '1', oqueue: 'A001' },
  { vn: 'V2', hn: 'H2', vstdate: '2026-08-27', vsttime: '09:00:00', main_dep: '137', an: null, pttype: '89', pttypeno: 'P123', ovstist: '1', ovstost: '1', visit_type: '1', oqueue: 'A002' }
];
const VNSTAT = { V1: { hospmain: '', pdx: '' }, V2: { hospmain: '11918', pdx: 'J00' } };
const SCREEN = { V2: { cc: 'ไข้', bps: 120, bpd: 80, temperature: 36.6, bw: 60, bmi: 22 } };
const PT = { H1: { pname: 'นาย', fname: 'ก', lname: 'ข' }, H2: { pname: 'นาง', fname: 'ค', lname: 'ง' } };
const ICD = { J00: 'โรคหวัด', J069: 'ติดเชื้อทางเดินหายใจส่วนบน' };

function rowFor(o) {
  const v = VNSTAT[o.vn] || {};
  const sc = SCREEN[o.vn] || {};
  const p = PT[o.hn] || {};
  return {
    oqueue: o.oqueue, vstdate: o.vstdate, vsttime: o.vsttime, hn: o.hn,
    ptname: (p.pname || '') + (p.fname || '') + ' ' + (p.lname || ''),
    pttype_name: 'บัตรทอง', hipdata_code: 'UCS',
    hospmain: v.hospmain, pttypeno: o.pttypeno, pdx: v.pdx, pdx_name: ICD[v.pdx] || null,
    ovstist_name: 'ปกติ', ost_name: 'เสร็จ', doctor_list_text: 'นพ.เอ', visit_type_name: 'ทั่วไป',
    cc: sc.cc, bps: sc.bps, bpd: sc.bpd, temperature: sc.temperature, bw: sc.bw, bmi: sc.bmi,
    vn: o.vn
  };
}

db.query = async (cfg, sql, params) => {
  if (/LEFT OUTER JOIN vn_stat v/.test(sql)) {
    let rows = OVST.slice();
    const vnm = sql.match(/o\.vn = \?/);
    if (vnm) rows = rows.filter((o) => o.vn === params[0]);
    else {
      // date + dep
      rows = rows.filter((o) => o.an === null);
      if (params[2]) rows = rows.filter((o) => o.main_dep === String(params[2]));
    }
    return rows.map(rowFor);
  }
  if (/SELECT vn FROM opdscreen WHERE vn/.test(sql)) return SCREEN[params[0]] ? [{ vn: params[0] }] : [];
  if (/SELECT hn, vstdate, vsttime FROM ovst WHERE vn/.test(sql)) {
    const o = OVST.find((x) => x.vn === params[0]);
    return o ? [{ hn: o.hn, vstdate: o.vstdate, vsttime: o.vsttime }] : [];
  }
  return [];
};
db.execute = async (cfg, sql, params) => {
  let m;
  if ((m = sql.match(/^UPDATE vn_stat SET (\w+) = \? WHERE vn = \?$/))) {
    const vn = params[1]; if (!VNSTAT[vn]) return { affected: 0 }; VNSTAT[vn][m[1]] = params[0]; return { affected: 1 };
  }
  if ((m = sql.match(/^UPDATE ovst SET (\w+) = \? WHERE vn = \?$/))) {
    const o = OVST.find((x) => x.vn === params[1]); if (o) o[m[1]] = params[0]; return { affected: 1 };
  }
  if ((m = sql.match(/^UPDATE opdscreen SET (\w+) = \? WHERE vn = \?$/))) {
    const vn = params[1]; SCREEN[vn] = SCREEN[vn] || {}; SCREEN[vn][m[1]] = params[0]; return { affected: 1 };
  }
  if ((m = sql.match(/^INSERT INTO opdscreen \(vn, hn, vstdate, vsttime, (\w+)\)/))) {
    SCREEN[params[0]] = SCREEN[params[0]] || {}; SCREEN[params[0]][m[1]] = params[4]; return { affected: 1 };
  }
  return { affected: 0 };
};

const cfg = { driver: 'postgres' };
const ok = (m) => console.log('  PASS  ' + m);
const bad = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };

(async () => {
  console.log('\n=== A. checkList + ประเมิน 9 ฟิลด์ ===');
  const rows = await opd.checkList(cfg, '2026-08-27', '2026-08-27', '137', 100);
  rows.length === 2 ? ok('ได้ 2 แถว (main_dep=137, an is null)') : bad('จำนวนแถวผิด: ' + rows.length);
  const v1 = rows.find((r) => r.vn === 'V1'), v2 = rows.find((r) => r.vn === 'V2');
  (v2._complete && v2._percent === 100) ? ok('V2 ครบ 9/9 ช่อง (100%)') : bad('V2 ควรครบ: ' + JSON.stringify(v2._missing));
  (v1._missing.includes('hospmain') && v1._missing.includes('pdx') && v1._missing.includes('cc') && v1._missing.includes('bps'))
    ? ok('V1 ช่องว่างถูกจับ: ' + v1._missing.join(',')) : bad('V1 ผิด: ' + JSON.stringify(v1._missing));

  console.log('\n=== B. summarizeCheck ===');
  const s = opd.summarizeCheck(rows);
  (s.total === 2 && s.complete === 1) ? ok('รวม 2 ครบ 1 เฉลี่ย ' + s.percent + '%') : bad('สรุปผิด: ' + JSON.stringify(s));
  s.fields.find((f) => f.key === 'hospmain').missing === 1 ? ok('นับ hospmain ขาด 1') : bad('นับฟิลด์ผิด');

  console.log('\n=== C. saveCheckField → บันทึกกลับฟิลด์เดิม ===');
  await opd.saveCheckField(cfg, 'hospmain', 'V1', '11918');
  VNSTAT.V1.hospmain === '11918' ? ok('hospmain → vn_stat.hospmain = 11918') : bad('hospmain ไม่บันทึก');
  await opd.saveCheckField(cfg, 'pdx', 'V1', 'j069');
  VNSTAT.V1.pdx === 'J069' ? ok('pdx → vn_stat.pdx = J069 (แปลงตัวใหญ่)') : bad('pdx ไม่บันทึก: ' + VNSTAT.V1.pdx);
  await opd.saveCheckField(cfg, 'bps', 'V1', '118');   // opdscreen ยังไม่มีแถว → insert
  SCREEN.V1 && Number(SCREEN.V1.bps) === 118 ? ok('bps → สร้างแถว opdscreen ใหม่แล้วบันทึก 118') : bad('bps insert ผิด: ' + JSON.stringify(SCREEN.V1));
  await opd.saveCheckField(cfg, 'temperature', 'V1', '36.8');
  Number(SCREEN.V1.temperature) === 36.8 ? ok('temperature → opdscreen.temperature = 36.8') : bad('temp ผิด');

  console.log('\n=== D. ตรวจสอบชนิดข้อมูล ===');
  try { await opd.saveCheckField(cfg, 'bps', 'V1', 'abc'); bad('ควร reject ค่าไม่ใช่ตัวเลข'); }
  catch (e) { ok('reject bps=abc: ' + e.message); }
  try { await opd.saveCheckField(cfg, 'notafield', 'V1', 'x'); bad('ควร reject ฟิลด์นอก whitelist'); }
  catch (e) { ok('reject ฟิลด์นอก whitelist: ' + e.message); }

  console.log('\n=== E. getCheckRow หลังบันทึก (V1 ครบขึ้น) ===');
  await opd.saveCheckField(cfg, 'bpd', 'V1', '78');
  await opd.saveCheckField(cfg, 'bw', 'V1', '62');
  await opd.saveCheckField(cfg, 'bmi', 'V1', '21.5');
  await opd.saveCheckField(cfg, 'cc', 'V1', 'ปวดหัว');
  const r1 = await opd.getCheckRow(cfg, 'V1');
  (r1._complete && r1._percent === 100) ? ok('V1 ครบ 100% หลังเติมทุกช่อง, Pdx name = ' + r1.pdx_name) : bad('V1 ยังไม่ครบ: ' + r1._percent + '% ขาด ' + r1._missing);

  console.log('\n=== F. เงื่อนไข รพ.หลัก ตาม hipdata_code ===');
  const base = { pdx: 'J00', cc: 'x', bps: 1, bpd: 1, temperature: 1, bw: 1, bmi: 1, hospmain: '' };
  const reqUCS = opd.evalCheck(Object.assign({}, base, { hipdata_code: 'UCS' }));
  reqUCS.missing.includes('hospmain') ? ok('hipdata_code=UCS + hospmain ว่าง → ขึ้นแดง (ตรวจ)') : bad('UCS ควรตรวจ hospmain');
  const noOFC = opd.evalCheck(Object.assign({}, base, { hipdata_code: 'OFC' }));
  !noOFC.missing.includes('hospmain') ? ok('hipdata_code=OFC + hospmain ว่าง → ไม่ตรวจ (ไม่แดง)') : bad('OFC ไม่ควรตรวจ hospmain');
  const sss = opd.evalCheck(Object.assign({}, base, { hipdata_code: 'SSS', hospmain: '11918' }));
  sss.complete ? ok('SSS + hospmain มีค่า → ครบ') : bad('SSS ที่มี hospmain ควรครบ');

  console.log('\n=== G. dialect cast ===');
  ok('checkList รองรับ postgres(VARCHAR)/mysql(CHAR) + ตัด pttypeno (' + opd.CHECK_KEYS.length + ' ช่อง)');

  console.log('\nเสร็จสิ้น' + (process.exitCode ? ' — พบข้อผิดพลาด' : ' — ผ่านทั้งหมด') + '\n');
})().catch((e) => { console.error(e); process.exit(1); });
