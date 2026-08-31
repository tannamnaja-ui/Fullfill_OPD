/* ทดสอบระบบ (จำลองการทำงานของเบราว์เซอร์) — node tools/smoke.js */
'use strict';
global.window = global;
require('../public/js/crypto.js');
const FF = global.FFCrypto;

const BASE = 'http://localhost:' + (process.env.PORT || 3006);
let boot = null;
let key = '';
let session = '';

const ok = (m) => console.log('  ✔ ' + m);
const bad = (m) => { console.log('  ✘ ' + m); process.exitCode = 1; };

async function getBoot(path) {
  const html = await (await fetch(BASE + path)).text();
  const m = html.match(/window\.__BOOT\s*=\s*(\{[\s\S]*?\});/);
  if (!m) throw new Error('ไม่พบ boot data ในหน้า ' + path);
  return JSON.parse(m[1]);
}

async function call(name, payload, tokenOverride) {
  const rid = boot.r[name];
  if (!rid) throw new Error('ไม่รู้จัก endpoint ' + name);
  const k = tokenOverride !== undefined ? tokenOverride : key;
  const body = Object.assign({}, payload, { _s: session });
  const res = await fetch(BASE + boot.ep + rid, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-API-Token': k },
    body: FF.seal(body, k)
  });
  const text = await res.text();
  const data = FF.open(text, k);
  return { status: res.status, data, raw: text };
}

(async () => {
  console.log('\n=== 1. หน้าเว็บและ boot data ===');
  boot = await getBoot('/');
  key = boot.k;
  console.log('  routes:', Object.keys(boot.r).length, '| setup mode:', boot.setup);
  Object.keys(boot.r).length === 19 ? ok('แผนที่เส้นทางครบ 19 endpoint') : bad('เส้นทางไม่ครบ');
  /^[0-9a-f]{24}$/.test(boot.r['auth.login']) ? ok('เส้นทาง API ถูกเข้ารหัส เช่น /q/' + boot.r['auth.login']) : bad('เส้นทางไม่ถูกเข้ารหัส');

  console.log('\n=== 2. ป้องกันการยิงตรงแบบ Postman ===');
  {
    const rid = boot.r['data.dashboard'];
    const r1 = await fetch(BASE + '/q/' + rid, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"from":"2026-08-27"}' });
    const t1 = await r1.text();
    r1.status === 401 ? ok('ไม่มี token → 401 : ' + JSON.parse(t1).error) : bad('ควรตอบ 401 แต่ได้ ' + r1.status);

    const r2 = await fetch(BASE + '/q/' + '0'.repeat(24), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    r2.status === 404 ? ok('เดาเส้นทางไม่ได้ → 404') : bad('ควรตอบ 404 แต่ได้ ' + r2.status);
  }

  console.log('\n=== 3. สร้าง Token ===');
  {
    const r = await call('settings.token', { hospCode: '10670' });
    if (!r.data || !r.data.ok) return bad('สร้าง token ไม่สำเร็จ: ' + JSON.stringify(r));
    const tk = r.data.token;
    (tk.startsWith('10670') && tk.length === 15) ? ok('Token = ' + tk + ' (ขึ้นต้นด้วยรหัสสถานพยาบาล + 10 หลัก)') : bad('รูปแบบ token ไม่ถูก: ' + tk);
    global.__tk = tk;
  }

  console.log('\n=== 4. ทดสอบการเชื่อมต่อ (คาดว่าล้มเหลวเพราะไม่มี DB) ===');
  {
    const r = await call('settings.test', {
      driver: 'mysql', host: '127.0.0.1', port: 3306, database: 'hos', username: 'sa', password: 'x'
    });
    if (r.data && r.data.result) ok('ตอบกลับผลทดสอบ: ' + (r.data.result.ok ? 'สำเร็จ' : r.data.result.error));
    else bad('ไม่ได้ผลทดสอบ: ' + JSON.stringify(r.data));
  }

  console.log('\n=== 5. บันทึกค่าการเชื่อมต่อ ===');
  {
    const r = await call('settings.save', {
      driver: 'mysql', host: '127.0.0.1', port: 3306, database: 'hos',
      username: 'sa', password: 'secret123', hospCode: '10670', token: global.__tk
    });
    if (!r.data || !r.data.ok) return bad('บันทึกไม่สำเร็จ: ' + JSON.stringify(r.data));
    ok('บันทึกแล้ว token = ' + r.data.token);
    key = r.data.token;
  }

  console.log('\n=== 6. จำค่าที่ตั้งไว้ (โหลดหน้า login ใหม่) ===');
  {
    boot = await getBoot('/');
    const r = await call('settings.get', {});
    const c = r.data.config;
    (c.host === '127.0.0.1' && c.database === 'hos' && c.username === 'sa' && c.password === '********')
      ? ok('จำค่าได้: ' + c.driver + ' ' + c.host + ':' + c.port + '/' + c.database + ' (รหัสผ่านถูกปกปิด/เข้ารหัสในไฟล์)')
      : bad('ค่าที่จำไม่ถูกต้อง: ' + JSON.stringify(c));
    c.token === key ? ok('Token ถูกจำไว้') : bad('token ไม่ตรง');
    boot.setup === false ? ok('ออกจากโหมดตั้งค่าแล้ว') : bad('ยังอยู่โหมดตั้งค่า');
  }

  console.log('\n=== 7. token ผิด ต้องไม่ได้ข้อมูล ===');
  {
    const r = await call('settings.get', {}, '10670WRONGTOKENX');
    r.status === 403 ? ok('token ผิด → 403 ' + JSON.parse(r.raw).error) : bad('ควร 403 แต่ได้ ' + r.status);
  }

  console.log('\n=== 8. เรียกข้อมูลโดยไม่ได้ login ===');
  {
    const r = await call('data.dashboard', { from: '2026-08-27' });
    r.status === 401 ? ok('ไม่มี session → 401 (ข้อความถูกเข้ารหัส)') : bad('ควร 401 แต่ได้ ' + r.status);
  }

  console.log('\n=== 9. เข้าสู่ระบบ (ไม่มี DB จริง จึงต้องแจ้งข้อผิดพลาดฐานข้อมูล) ===');
  {
    const r = await call('auth.login', { username: 'admin', password: '1234' });
    if (r.data && !r.data.ok) ok('ตอบกลับแบบเข้ารหัส: ' + r.data.error.slice(0, 80));
    else bad('ผลลัพธ์ผิดคาด: ' + JSON.stringify(r.data));
  }

  console.log('\n=== 10. ตรวจว่า response ถูกเข้ารหัสจริง ===');
  {
    const r = await call('settings.get', {});
    /^[0-9a-f]{24}\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/.test(r.raw)
      ? ok('รูปแบบ ciphertext ถูกต้อง: ' + r.raw.slice(0, 46) + '…')
      : bad('response ไม่ได้เข้ารหัส');
    r.raw.includes('127.0.0.1') ? bad('ข้อมูลรั่วเป็น plaintext') : ok('ไม่พบ plaintext ใน response');
  }

  console.log('\nเสร็จสิ้น' + (process.exitCode ? ' — พบข้อผิดพลาด' : ' — ผ่านทั้งหมด ✅') + '\n');
})().catch((e) => { console.error('ล้มเหลว:', e); process.exit(1); });
