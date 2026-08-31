/* ทดสอบ BMS session login + ดึง/บันทึกข้อมูลผ่าน API tunnel (จำลอง browser) */
'use strict';
global.window = global;
require('../public/js/crypto.js');
const FF = global.FFCrypto;

const BASE = 'http://localhost:' + (process.env.PORT || 3006);
const SID = 'BMS-TEST-SESSION-123';
let boot = null, key = '', session = '';

const ok = (m) => console.log('  PASS  ' + m);
const bad = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };

async function getBoot(path) {
  const html = await (await fetch(BASE + path)).text();
  const m = html.match(/window\.__BOOT\s*=\s*(\{[\s\S]*?\});/);
  return JSON.parse(m[1]);
}
async function call(name, payload) {
  const rid = boot.r[name];
  const body = Object.assign({}, payload, { _s: session });
  const res = await fetch(BASE + boot.ep + rid, {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-API-Token': key }, body: FF.seal(body, key)
  });
  const text = await res.text();
  return { status: res.status, data: FF.open(text, key), raw: text };
}

(async () => {
  console.log('\n=== BMS: boot ===');
  boot = await getBoot('/');
  key = boot.k;
  boot.r['auth.bms'] ? ok('มี endpoint auth.bms (เข้ารหัสเส้นทาง /q/' + boot.r['auth.bms'] + ')') : bad('ไม่มี auth.bms');

  console.log('\n=== BMS: session ผิด ต้องถูกปฏิเสธ ===');
  {
    const r = await call('auth.bms', { sessionId: 'WRONG-SESSION' });
    (r.status === 401 || r.status === 440) && r.data && !r.data.ok ? ok('session ผิด → ปฏิเสธ: ' + r.data.error) : bad('ควรปฏิเสธ: ' + JSON.stringify(r).slice(0, 120));
  }

  console.log('\n=== BMS: เข้าสู่ระบบด้วย session ที่ถูกต้อง (ไม่ใช้ user/pass) ===');
  {
    const r = await call('auth.bms', { sessionId: SID });
    if (!r.data || !r.data.ok) return bad('เข้าไม่สำเร็จ: ' + JSON.stringify(r.data));
    session = r.data.session;
    r.data.mode === 'bms' ? ok('เข้าสำเร็จเป็น ' + r.data.user.name + ' (โหมด BMS, รพ. ' + r.data.user.location + ')') : bad('mode ไม่ใช่ bms');
  }

  console.log('\n=== BMS: auth.me รายงานโหมด bms ===');
  {
    const r = await call('auth.me', {});
    r.data && r.data.mode === 'bms' ? ok('auth.me → mode=bms, user=' + r.data.user.name) : bad('auth.me ผิด: ' + JSON.stringify(r.data));
  }

  console.log('\n=== BMS: ดึงจุดบริการผ่าน API tunnel ===');
  {
    const r = await call('data.departments', { from: '2026-08-27', to: '2026-08-27' });
    (r.data && r.data.ok && r.data.departments.length === 2)
      ? ok('ได้ ' + r.data.departments.length + ' จุดบริการ: ' + r.data.departments.map((d) => d.dep_name).join(', '))
      : bad('ดึงจุดบริการผิด: ' + JSON.stringify(r.data).slice(0, 150));
  }

  console.log('\n=== BMS: แดชบอร์ด (visits + summarize ผ่าน tunnel) ===');
  {
    const r = await call('data.dashboard', { from: '2026-08-27', to: '2026-08-27' });
    const s = r.data && r.data.summary;
    (s && s.total === 3 && s.complete === 1) ? ok('รวม 3 ครบ 1 เฉลี่ย ' + s.percent + '% (ผ่าน BMS API)') : bad('แดชบอร์ดผิด: ' + JSON.stringify(s).slice(0, 120));
  }

  console.log('\n=== BMS: บันทึกข้อมูลเพิ่ม (INSERT/UPDATE ผ่าน tunnel) ===');
  {
    const r = await call('save.visit', { vn: 'V1', data: {
      pttype: '89', doctor: 'D1', ovstost: '1',
      bps: 118, bpd: 76, pulse: 72, rr: 18, temperature: 36.5, bw: 60, height: 165, o2sat: 97,
      cc: 'ปวดศีรษะ มา 2 วัน', icd10: 'J00', diagtype: '1'
    } });
    if (!r.data || !r.data.ok) return bad('บันทึกไม่สำเร็จ: ' + JSON.stringify(r.data).slice(0, 150));
    r.data.changed.length >= 10 ? ok('บันทึก ' + r.data.changed.length + ' รายการ, ความสมบูรณ์ V1 = ' + r.data.visit._percent + '%') : bad('บันทึกได้น้อย: ' + JSON.stringify(r.data.changed));
    // ทุกช่องที่กรอกได้ต้องครบ เหลือเพียง item (ยา/หัตถการ จากระบบจ่ายยา — กรอกผ่านฟอร์มนี้ไม่ได้)
    const miss = r.data.visit._missing;
    (miss.length === 1 && miss[0] === 'item')
      ? ok('ทุกช่องที่แก้ไขได้ครบแล้ว เหลือเฉพาะ item (ยา/หัตถการจาก HOSxP)')
      : bad('ควรเหลือเฉพาะ item แต่ขาด: ' + JSON.stringify(miss));
  }

  console.log('\n=== BMS: ค้นหา ICD-10 ผ่าน tunnel ===');
  {
    const r = await call('data.icd10', { q: 'J0' });
    (r.data && r.data.items.length >= 1) ? ok('ค้นหา ICD-10 ได้ ' + r.data.items.length + ' รายการ') : bad('ค้นหา icd10 ผิด');
  }

  console.log('\n=== BMS: response ยังถูกเข้ารหัส ===');
  {
    const r = await call('auth.me', {});
    /^[0-9a-f]{24}\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/.test(r.raw) ? ok('ciphertext ถูกต้อง') : bad('ไม่ได้เข้ารหัส');
  }

  console.log('\nเสร็จสิ้น' + (process.exitCode ? ' — พบข้อผิดพลาด' : ' — ผ่านทั้งหมด') + '\n');
})().catch((e) => { console.error('ล้มเหลว:', e); process.exit(1); });
