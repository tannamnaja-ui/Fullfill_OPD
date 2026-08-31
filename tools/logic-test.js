/* ทดสอบตรรกะ opd.js ด้วย mock DB (ไม่ต้องมีฐานข้อมูลจริง) */
'use strict';
const opd = require('../server/lib/opd');
const audit = require('../server/lib/audit');

const T = {
  ovst: [
    { vn: 'V1', hn: 'H1', vstdate: '2026-08-27', vsttime: '08:30:00', main_dep: '01', pttype: '', doctor: '', spclty: '01', ovstost: '' },
    { vn: 'V2', hn: 'H2', vstdate: '2026-08-27', vsttime: '09:10:00', main_dep: '01', pttype: '89', doctor: 'D1', spclty: '01', ovstost: '1' },
    { vn: 'V3', hn: 'H3', vstdate: '2026-08-27', vsttime: '10:00:00', main_dep: '02', pttype: '', doctor: '', spclty: '02', ovstost: '' }
  ],
  patient: {
    H1: { pname: 'นาย', fname: 'สมชาย', lname: 'ใจดี', cid: '1234567890123', birthday: '1990-01-01', sex: '1' },
    H2: { pname: 'นาง', fname: 'สมหญิง', lname: 'รักดี', cid: '9999999999999', birthday: '1985-05-05', sex: '2' },
    H3: { pname: 'นาย', fname: 'อาทิตย์', lname: 'แจ่ม', cid: '12', birthday: '2000-03-03', sex: '1' }
  },
  opdscreen: { V2: { bps: 120, bpd: 80, pulse: 78, rr: 20, temperature: 36.6, bw: 65, height: 170, o2sat: 98, cc: 'ไข้ ไอ' } },
  ksk: { '01': 'ห้องตรวจอายุรกรรม', '02': 'ห้องตรวจศัลยกรรม' },
  ovstdiag: { V2: [{ icd10: 'J00', diagtype: '1' }] },
  opitemrec: { V2: [{}, {}] }
};

const db = require('../server/lib/db');
db.query = async (cfg, sql, params) => {
  if (/GROUP BY o\.main_dep/.test(sql)) {
    const map = {};
    T.ovst.forEach((o) => { map[o.main_dep] = (map[o.main_dep] || 0) + 1; });
    return Object.keys(map).map((dep) => ({ dep_code: dep, dep_name: T.ksk[dep] || ('จุดบริการ ' + dep), visit_count: map[dep] }))
      .sort((a, b) => b.visit_count - a.visit_count);
  }
  if (/FROM ovst o/.test(sql) && /LEFT JOIN patient/.test(sql)) {
    let rows = T.ovst.slice();
    if (/o\.vn = \?/.test(sql)) rows = rows.filter((o) => o.vn === params[0]);
    else if (params[2]) rows = rows.filter((o) => o.main_dep === params[2]);
    return rows.map((o) => {
      const p = T.patient[o.hn] || {};
      const s = T.opdscreen[o.vn] || {};
      return Object.assign({}, o, p, s, {
        dep_name: T.ksk[o.main_dep] || ('จุดบริการ ' + o.main_dep),
        dx_count: (T.ovstdiag[o.vn] || []).length,
        item_count: (T.opitemrec[o.vn] || []).length
      });
    });
  }
  if (/FROM opdscreen WHERE vn/.test(sql)) return T.opdscreen[params[0]] ? [{ vn: params[0] }] : [];
  if (/FROM ovstdiag WHERE vn = \? AND icd10/.test(sql)) {
    const list = T.ovstdiag[params[0]] || [];
    return list.filter((d) => d.icd10 === params[1]).map(() => ({ vn: params[0] }));
  }
  if (/FROM ovstdiag d/.test(sql)) {
    return (T.ovstdiag[params[0]] || []).map((d) => ({ icd10: d.icd10, diagtype: d.diagtype, name: d.icd10 === 'J00' ? 'ไข้หวัด' : '' }));
  }
  if (/FROM doctor/.test(sql)) return [{ code: 'D1', name: 'นพ.ทดสอบ' }];
  if (/FROM pttype/.test(sql)) return [{ code: '89', name: 'บัตรทอง' }];
  if (/FROM ovstost/.test(sql)) return [{ code: '1', name: 'เสร็จสิ้น' }];
  if (/FROM icd101/.test(sql)) return [{ code: 'J00', name: 'โรคหวัด' }];
  return [];
};
db.execute = async (cfg, sql, params) => {
  if (/INSERT INTO opdscreen/.test(sql)) { T.opdscreen[params[0]] = { bps: params[4] }; return { affected: 1 }; }
  if (/UPDATE opdscreen/.test(sql)) return { affected: 1 };
  if (/UPDATE ovst SET/.test(sql)) {
    const vn = params[params.length - 1];
    const o = T.ovst.find((x) => x.vn === vn);
    const cols = sql.match(/SET (.+) WHERE/)[1].split(',').map((s) => s.trim().split(' ')[0]);
    cols.forEach((c, i) => { if (o) o[c] = params[i]; });
    return { affected: 1 };
  }
  if (/INSERT INTO ovstdiag/.test(sql)) {
    (T.ovstdiag[params[0]] = T.ovstdiag[params[0]] || []).push({ icd10: params[3], diagtype: params[4] });
    return { affected: 1 };
  }
  return { affected: 0 };
};

const cfg = { driver: 'mysql' };
const ok = (m) => console.log('  PASS  ' + m);
const bad = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };

(async () => {
  console.log('\n=== A. departments (main_dep เทียบ kskdepartment) ===');
  const deps = await opd.departments(cfg, '2026-08-27', '2026-08-27');
  (deps.length === 2 && deps[0].dep_name === 'ห้องตรวจอายุรกรรม')
    ? ok('2 จุดบริการ: ' + deps.map((d) => d.dep_name + '(' + d.visit_count + ')').join(', '))
    : bad('ผิด: ' + JSON.stringify(deps));

  console.log('\n=== B. visits + ประเมินความสมบูรณ์ ===');
  const vs = await opd.visits(cfg, '2026-08-27', '2026-08-27', '', 100);
  const v1 = vs.find((x) => x.vn === 'V1'), v2 = vs.find((x) => x.vn === 'V2'), v3 = vs.find((x) => x.vn === 'V3');
  v2._complete ? ok('V2 ครบถ้วน 100% (' + v2.full_name + ')') : bad('V2 ควรครบ: ' + JSON.stringify(v2._missing));
  (!v1._complete && v1._missing.includes('pttype') && v1._missing.includes('bp')) ? ok('V1 ขาด: ' + v1._missing.join(',')) : bad('V1 ผิด');
  v3._missing.includes('cid') ? ok('V3 เลขบัตรไม่ครบ 13 หลัก ถูกจับได้') : bad('V3 ควรจับ cid');

  console.log('\n=== C. summarize (แดชบอร์ด) ===');
  const s = opd.summarize(vs);
  (s.total === 3 && s.complete === 1) ? ok('รวม 3 ครบ 1 ไม่ครบ ' + s.incomplete + ' เฉลี่ย ' + s.percent + '%') : bad('สรุปผิด');
  s.deps.length === 2 ? ok('สรุปราย 2 จุดบริการ') : bad('deps ผิด');
  s.items[0].missing > 0 ? ok('รายการที่ขาดมากสุด: ' + s.items[0].label + ' (' + s.items[0].missing + ')') : bad('items ผิด');

  console.log('\n=== D. saveScreen + saveVisitFields + addDiag ===');
  const before = await opd.getVisit(cfg, 'V1');
  await opd.saveScreen(cfg, before, { bps: 118, bpd: 76, pulse: 72, rr: 18, temperature: 36.5, bw: 60, height: 165, cc: 'ปวดหัว' });
  await opd.saveVisitFields(cfg, 'V1', { pttype: '89', doctor: 'D1', ovstost: '1' });
  const dg = await opd.addDiag(cfg, before, 'J00', '1', 'D1');
  const after = await opd.getVisit(cfg, 'V1');
  (after.pttype === '89' && after.doctor === 'D1') ? ok('ovst ถูกอัปเดต (pttype/doctor/ovstost)') : bad('ovst ไม่อัปเดต');
  dg.affected === 1 ? ok('เพิ่ม ICD-10 J00 สำเร็จ') : bad('addDiag ผิด');
  const dup = await opd.addDiag(cfg, before, 'J00', '1', 'D1');
  dup.duplicated ? ok('กันการวินิจฉัยซ้ำได้') : bad('ควรกันซ้ำ');

  console.log('\n=== E. audit log (ข้อมูลที่ลงเพิ่ม) ===');
  audit.write({ vn: 'V1', hn: 'H1', vstdate: '2026-08-27', main_dep: '01', dep_name: 'ห้องตรวจอายุรกรรม', patient: 'นายสมชาย ใจดี', user: 'admin', userName: 'ผู้ดูแล', fields: ['bps', 'bpd', 'pttype', 'icd10:J00'] });
  const sum = audit.summary(audit.read('2026-08-27', '2026-08-27', ''));
  (sum.entries >= 1 && sum.fields >= 4) ? ok('บันทึกประวัติ ' + sum.fields + ' รายการ โดย ' + sum.byUser[0].key) : bad('audit ผิด');

  console.log('\n=== F. PostgreSQL dialect ===');
  const pgSql = opd.sqlFor({ driver: 'postgres' }, 'WHERE d BETWEEN {{D}} AND {{D}}');
  pgSql.includes('?::date') ? ok('แปลง {{D}} เป็น ?::date สำหรับ PostgreSQL') : bad('dialect ผิด');

  console.log('\nเสร็จสิ้น' + (process.exitCode ? ' — พบข้อผิดพลาด' : ' — ผ่านทั้งหมด') + '\n');
})().catch((e) => { console.error(e); process.exit(1); });
