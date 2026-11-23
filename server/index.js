'use strict';
/**
 * ระบบตรวจสอบความสมบูรณ์การลงข้อมูลผู้รับบริการ OPD
 * Server: Express (port 3006)
 *
 * ความปลอดภัย
 *  - เส้นทาง API ถูกเข้ารหัสเป็นรหัส 24 หลัก (HMAC ของชื่อ endpoint กับ secret ประจำเครื่อง)
 *  - ทุก request/response ถูกเข้ารหัสด้วยกุญแจที่ได้จาก token ของสถานพยาบาล
 *  - ถ้าไม่มี token ที่ถูกต้อง จะไม่มีข้อมูลใด ๆ ส่งกลับ (เช่น ยิงจาก Postman)
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');

const secure = require('./lib/secure');
const cfgStore = require('./lib/config');
const db = require('./lib/db');
const auth = require('./lib/auth');
const opd = require('./lib/opd');
const dental = require('./lib/dental');
const physio = require('./lib/physio');
const anc = require('./lib/anc');
const ipd = require('./lib/ipd');
const emr = require('./lib/emr');
const audit = require('./lib/audit');
const bms = require('./lib/bms');

const PORT = process.env.PORT || 3006;
const APP_SECRET = cfgStore.appSecret();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* ---------------- แผนที่เส้นทางที่เข้ารหัส ---------------- */
const ENDPOINTS = [
  'settings.get', 'settings.test', 'settings.save', 'settings.token',
  'auth.login', 'auth.bms', 'auth.bmsresume', 'auth.me', 'auth.logout',
  'data.departments', 'data.dashboard', 'data.visits', 'data.visit',
  'data.lookup', 'data.icd10', 'data.doctors', 'data.audit',
  'data.checklist', 'save.field',
  'data.diags', 'diag.add', 'diag.update', 'diag.doctor', 'diag.delete',
  'data.dentalcheck', 'data.dentallookups', 'save.dentalfield', 'save.dentalfill',
  'data.emr', 'data.emrvisits',
  'data.physiocheck', 'save.physiofield', 'save.physiomerge', 'save.physiofinish',
  'data.anccheck', 'save.ancfield',
  'data.ipdcheck', 'data.ipddetail', 'save.ipdfield', 'data.icd9',
  'ipd.diagadd', 'ipd.diagupdate', 'ipd.diagdelete', 'ipd.procadd', 'ipd.procupdate', 'ipd.procdelete',
  'save.visit'
];
const ROUTE_MAP = {};      // ชื่อ -> รหัส
const ROUTE_REV = {};      // รหัส -> ชื่อ
for (const name of ENDPOINTS) {
  const id = secure.routeId(APP_SECRET, name);
  ROUTE_MAP[name] = id;
  ROUTE_REV[id] = name;
}

/** endpoint ที่เรียกได้ก่อน login */
const OPEN_ENDPOINTS = new Set([
  'settings.get', 'settings.test', 'settings.save', 'settings.token', 'auth.login', 'auth.bms', 'auth.bmsresume'
]);

/* ---------------- แคช config การเชื่อมต่อ BMS ต่อ session (เก็บ auth key ฝั่ง server เท่านั้น) ---------------- */
const bmsCache = new Map();   // sessionId -> { api, user, at }
function cacheBms(sessionId, api, user) {
  bmsCache.set(sessionId, { api, user, at: Date.now() });
}
async function bmsApiFor(sessionId) {
  const hit = bmsCache.get(sessionId);
  if (hit) return hit;
  // แคชหาย (เช่น เซิร์ฟเวอร์รีสตาร์ท) → ดึง session ใหม่จาก HOSxP
  const r = await bms.retrieveSession(sessionId);
  if (!r.ok) { const e = new Error(r.error); e.status = r.expired ? 440 : 401; throw e; }
  cacheBms(sessionId, r.api, r.user);
  return bmsCache.get(sessionId);
}

/** คืน cfg สำหรับ endpoint ข้อมูล ตามชนิดของ session (BMS หรือ DB ตรง) */
async function contextFor(session) {
  if (session && session.mode === 'bms' && session.bms) {
    const entry = await bmsApiFor(session.bms);
    return { driver: 'mysql', bms: entry.api };   // HOSxP = MariaDB
  }
  return requireDb();
}

/* ---------------- App ---------------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '1mb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

/* ---------------- หน้าเว็บ (inject boot data) ---------------- */
function renderPage(file, res) {
  const cfg = cfgStore.load();
  const boot = {
    r: ROUTE_MAP,
    k: cfg.token || ('SETUP-' + APP_SECRET.slice(0, 16)),
    setup: !cfg.token,
    hosp: cfg.hospCode || '',
    bmsSaved: !!cfg.bmsSession,   // มี BMS session ที่จำไว้ → เข้าอัตโนมัติได้เลย
    ep: '/q/'
  };
  let html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  html = html.replace('"__BOOT__"', JSON.stringify(boot));
  res.type('html').send(html);
}

app.get('/', (req, res) => renderPage('login.html', res));
app.get('/login', (req, res) => renderPage('login.html', res));
app.get('/app', (req, res) => renderPage('index.html', res));
app.get('/emr.html', (req, res) => renderPage('emr.html', res));

app.use('/css', express.static(path.join(PUBLIC_DIR, 'css')));
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js')));
app.use('/img', express.static(path.join(PUBLIC_DIR, 'img')));

/* ---------------- ตัวช่วย ---------------- */
const fail = (res, code, msg) => res.status(code).json({ ok: false, error: msg });

const loginAttempts = new Map();
function throttle(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key) || { n: 0, until: 0 };
  if (rec.until > now) return Math.ceil((rec.until - now) / 1000);
  return 0;
}
function noteFail(key) {
  const rec = loginAttempts.get(key) || { n: 0, until: 0 };
  rec.n++;
  if (rec.n >= 5) { rec.until = Date.now() + 60000; rec.n = 0; }
  loginAttempts.set(key, rec);
}
const clearFail = (key) => loginAttempts.delete(key);

function requireDb() {
  const cfg = cfgStore.load();
  if (!cfg.host || !cfg.database || !cfg.username) {
    const e = new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
    e.status = 400;
    throw e;
  }
  return cfg;
}

const today = () => new Date().toLocaleDateString('sv-SE');
const dateOr = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : today());

/* ---------------- API เส้นทางเดียว: /q/:rid ---------------- */
app.post('/q/:rid', async (req, res) => {
  const name = ROUTE_REV[req.params.rid];
  if (!name) return fail(res, 404, 'ไม่พบปลายทางที่ร้องขอ');

  const cfg = cfgStore.load();
  const firstRun = !cfg.token;

  // ตรวจ token ของสถานพยาบาล
  const sentToken = String(req.get('X-API-Token') || req.query.token || '').trim();
  let apiToken = cfg.token;

  if (firstRun) {
    // ยังไม่ตั้งค่า DB/token: ใช้กุญแจเริ่มต้น อนุญาตหน้าตั้งค่า + เข้าระบบด้วย BMS session
    // (endpoint หลัง login ยังต้องมี BMS session ที่ถูกต้องเสมอ — ตรวจด้านล่าง)
    apiToken = 'SETUP-' + APP_SECRET.slice(0, 16);
    const bmsFlow = name === 'auth.bms' || name === 'auth.bmsresume' || name === 'auth.me' || name === 'auth.logout' ||
                    name.startsWith('data.') || name.startsWith('save.') || name.startsWith('diag.');
    if (!name.startsWith('settings.') && !bmsFlow) {
      return fail(res, 401, 'ยังไม่ได้ตั้งค่าการเชื่อมต่อและ token');
    }
  } else {
    if (!sentToken) {
      return fail(res, 401, 'ต้องระบุ token ของสถานพยาบาลใน header: X-API-Token');
    }
    if (sentToken !== cfg.token) {
      return fail(res, 403, 'token ไม่ถูกต้อง');
    }
  }

  // ถอดรหัสคำขอ
  const raw = typeof req.body === 'string' ? req.body : (req.body && req.body.d);
  const payload = raw ? secure.open(raw, apiToken) : null;
  if (!payload) return fail(res, 400, 'รูปแบบคำขอไม่ถูกต้องหรือถอดรหัสไม่สำเร็จ');

  // ตรวจ session สำหรับ endpoint ที่ต้อง login
  let session = null;
  if (!OPEN_ENDPOINTS.has(name)) {
    session = secure.verifySession(payload._s || req.cookies.ffs || '', APP_SECRET);
    if (!session) return fail(res, 401, 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  }

  const reply = (obj) => res.type('text/plain').send(secure.seal(obj, apiToken));

  try {
    const out = await handle(name, payload, session, req, res);
    if (out === undefined) return;
    reply(Object.assign({ ok: true }, out));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[' + name + ']', err);
    res.status(status).type('text/plain').send(secure.seal({ ok: false, error: err.message || 'เกิดข้อผิดพลาด' }, apiToken));
  }
});

/* ---------------- ตัวจัดการแต่ละ endpoint ---------------- */
async function handle(name, p, session, req, res) {
  switch (name) {

    /* ---- ตั้งค่าการเชื่อมต่อ ---- */
    case 'settings.get':
      return { config: cfgStore.publicView(), routes: ROUTE_MAP };

    case 'settings.token':
      return { token: secure.generateToken(p.hospCode || cfgStore.load().hospCode || '') };

    case 'settings.test': {
      const cur = cfgStore.load();
      const test = {
        driver: p.driver === 'postgres' ? 'postgres' : 'mysql',
        host: String(p.host || '').trim(),
        port: parseInt(p.port, 10) || (p.driver === 'postgres' ? 5432 : 3306),
        database: String(p.database || '').trim(),
        username: String(p.username || '').trim(),
        password: (p.password === '********' || p.password === undefined) ? cur.password : String(p.password)
      };
      if (!test.host || !test.database || !test.username) {
        return { ok: false, error: 'กรุณากรอก IP Server, Database และ Username ให้ครบ' };
      }
      const r = await db.testConnection(test);
      return { result: r };
    }

    case 'settings.save': {
      const cur = cfgStore.load();
      const hospCode = String(p.hospCode || '').trim();
      const next = {
        driver: p.driver === 'postgres' ? 'postgres' : 'mysql',
        host: String(p.host || '').trim(),
        port: parseInt(p.port, 10) || (p.driver === 'postgres' ? 5432 : 3306),
        database: String(p.database || '').trim(),
        username: String(p.username || '').trim(),
        password: (p.password === '********' || p.password === undefined) ? cur.password : String(p.password),
        hospCode,
        token: String(p.token || '').trim() || cur.token || secure.generateToken(hospCode)
      };
      if (!next.host || !next.database || !next.username) {
        const e = new Error('กรุณากรอก IP Server, Database และ Username ให้ครบ');
        e.status = 400; throw e;
      }
      await db.closeAll();
      const saved = cfgStore.save(next);
      return { config: cfgStore.publicView(), token: saved.token };
    }

    /* ---- เข้าสู่ระบบ ---- */
    case 'auth.login': {
      const cfg = requireDb();
      const key = (req.ip || '') + '|' + String(p.username || '');
      const wait = throttle(key);
      if (wait) { const e = new Error('พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารออีก ' + wait + ' วินาที'); e.status = 429; throw e; }

      const r = await auth.login(cfg, p.username, p.password);
      if (!r.ok) {
        if (!r.dbError) noteFail(key);
        const e = new Error(r.reason); e.status = r.dbError ? 502 : 401; throw e;
      }
      clearFail(key);
      // login ด้วย username/password (officer) → session ไม่หมดอายุ (เครื่องหลักเปิดค้างตลอด)
      const token = secure.signSession({ u: r.user.username, n: r.user.name, id: r.user.officerId }, APP_SECRET, 0);
      res.cookie('ffs', token, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 365 * 24 * 3600 * 1000 });
      return { session: token, user: r.user };
    }

    /* ---- เข้าสู่ระบบด้วย BMS Session (ไม่ต้องใช้ username/password) ---- */
    case 'auth.bms': {
      const sid = String(p.sessionId || '').trim();
      if (!sid) { const e = new Error('ไม่ได้ระบุ BMS Session ID'); e.status = 400; throw e; }
      const r = await bms.retrieveSession(sid);
      if (!r.ok) { const e = new Error(r.error); e.status = r.expired ? 440 : 401; throw e; }
      cacheBms(sid, r.api, r.user);
      cfgStore.setBmsSession(sid);   // จำ BMS session ไว้ → ครั้งต่อไปเข้าได้เลยไม่ต้อง login
      const token = secure.signSession({ u: r.user.username, n: r.user.name, id: r.user.officerId, mode: 'bms', bms: sid }, APP_SECRET, 8 * 3600);
      res.cookie('ffs', token, { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000 });
      return { session: token, user: r.user, mode: 'bms' };
    }

    /* ---- เข้าระบบอัตโนมัติจาก BMS session ที่จำไว้ (ไม่ต้อง login) ---- */
    case 'auth.bmsresume': {
      const sid = cfgStore.getBmsSession();
      if (!sid) { const e = new Error('ยังไม่มี BMS session ที่จำไว้'); e.status = 401; throw e; }
      const r = await bms.retrieveSession(sid);
      if (!r.ok) {
        cfgStore.setBmsSession('');   // session หมดอายุ → ล้างทิ้ง
        const e = new Error(r.error); e.status = r.expired ? 440 : 401; throw e;
      }
      cacheBms(sid, r.api, r.user);
      const token = secure.signSession({ u: r.user.username, n: r.user.name, id: r.user.officerId, mode: 'bms', bms: sid }, APP_SECRET, 8 * 3600);
      res.cookie('ffs', token, { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000 });
      return { session: token, user: r.user, mode: 'bms' };
    }

    case 'auth.me':
      return { user: { username: session.u, name: session.n, officerId: session.id }, mode: session.mode || 'db' };

    case 'auth.logout':
      res.clearCookie('ffs');
      if (session && session.mode === 'bms') cfgStore.setBmsSession('');   // ออกจากระบบ BMS → เลิกจำ
      return { loggedOut: true };

    /* ---- ข้อมูล ---- */
    case 'data.departments': {
      const cfg = await contextFor(session);
      const from = dateOr(p.from), to = dateOr(p.to || p.from);
      return { departments: await opd.departments(cfg, from, to), from, to };
    }

    case 'data.dashboard': {
      const cfg = await contextFor(session);
      const from = dateOr(p.from), to = dateOr(p.to || p.from);
      const dep = p.dep ? String(p.dep) : '';
      // ใช้คิวรี่เดียวกับหน้าตรวจสอบ (LEFT JOIN ล้วน ไม่มี correlated subquery ต่อแถว)
      const rows = await opd.checkList(cfg, from, to, dep, 20000);
      const sum = opd.summarizeCheck(rows);
      const added = audit.summary(audit.read(from, to, dep));
      return { from, to, dep, summary: sum, added };
    }

    case 'data.visits': {
      const cfg = await contextFor(session);
      const from = dateOr(p.from), to = dateOr(p.to || p.from);
      const dep = p.dep ? String(p.dep) : '';
      let rows = await opd.visits(cfg, from, to, dep, 20000);
      if (p.status === 'incomplete') rows = rows.filter((r) => !r._complete);
      else if (p.status === 'complete') rows = rows.filter((r) => r._complete);
      if (p.missing) rows = rows.filter((r) => r._missing.includes(String(p.missing)));
      const q = String(p.q || '').trim().toLowerCase();
      if (q) {
        rows = rows.filter((r) =>
          String(r.hn || '').toLowerCase().includes(q) ||
          String(r.vn || '').toLowerCase().includes(q) ||
          String(r.full_name || '').toLowerCase().includes(q) ||
          String(r.cid || '').includes(q));
      }
      return { from, to, dep, rules: opd.RULE_META, total: rows.length, visits: rows.slice(0, 2000) };
    }

    case 'data.visit': {
      const cfg = await contextFor(session);
      const v = await opd.getVisit(cfg, String(p.vn || ''));
      if (!v) { const e = new Error('ไม่พบข้อมูลการมารับบริการนี้'); e.status = 404; throw e; }
      return { visit: v, diags: await opd.diagsOf(cfg, v.vn), rules: opd.RULE_META };
    }

    /* ---- หน้าตรวจสอบและเพิ่มข้อมูล (คิวรี่เฉพาะ + แก้ไขรายช่อง) ---- */
    case 'data.checklist': {
      const cfg = await contextFor(session);
      const from = dateOr(p.from), to = dateOr(p.to || p.from);
      const dep = p.dep ? String(p.dep) : '';
      const all = await opd.checkList(cfg, from, to, dep, 20000);
      // สรุปด้านบนอิงเฉพาะวันที่ + ห้องตรวจ (ไม่แปรตามสถานะ/คำค้น)
      const summary = opd.summarizeCheck(all);

      // ตัวกรองสถานะ/ค้นหา ใช้เฉพาะรายการในตารางเท่านั้น
      let rows = all;
      if (p.status === 'incomplete') rows = rows.filter((r) => !r._complete);
      else if (p.status === 'complete') rows = rows.filter((r) => r._complete);
      const q = String(p.q || '').trim().toLowerCase();
      if (q) {
        rows = rows.filter((r) =>
          String(r.hn || '').toLowerCase().includes(q) ||
          String(r.vn || '').toLowerCase().includes(q) ||
          String(r.ptname || '').toLowerCase().includes(q) ||
          String(r.oqueue || '').toLowerCase().includes(q));
      }
      return { from, to, dep, fields: opd.CHECK_META, summary, grandTotal: all.length, total: rows.length, rows: rows.slice(0, 3000) };
    }

    /* ---- แก้ไขการวินิจฉัย (ovstdiag) ของ visit ---- */
    case 'data.diags': {
      const cfg = await contextFor(session);
      const vn = String(p.vn || '');
      if (!vn) { const e = new Error('ไม่พบ VN'); e.status = 400; throw e; }
      return { vn, diags: await opd.diagsFull(cfg, vn), defaultDoctor: await opd.getVisitDoctor(cfg, vn) };
    }

    case 'diag.add': {
      const cfg = await contextFor(session);
      const vn = String(p.vn || '');
      const r = await opd.addDiagVn(cfg, vn, p.icd10, p.diagtype || '1', p.doctor, session.u);
      audit.write({ vn, hn: '', vstdate: '', main_dep: '', dep_name: '', patient: '',
        user: session.u, userName: session.n, fields: ['diag+:' + String(p.icd10 || '').toUpperCase()] });
      return { added: !!r.affected, duplicated: !!r.duplicated, diags: await opd.diagsFull(cfg, vn) };
    }

    case 'diag.update': {
      const cfg = await contextFor(session);
      const vn = String(p.vn || '');
      await opd.updateDiagType(cfg, vn, p.icd10, p.oldType, p.diagtype);
      return { updated: true, diags: await opd.diagsFull(cfg, vn) };
    }

    case 'diag.doctor': {
      const cfg = await contextFor(session);
      const vn = String(p.vn || '');
      await opd.updateDiagDoctor(cfg, vn, p.icd10, p.diagtype, p.doctor);
      return { updated: true, diags: await opd.diagsFull(cfg, vn) };
    }

    case 'diag.delete': {
      const cfg = await contextFor(session);
      const vn = String(p.vn || '');
      const r = await opd.deleteDiag(cfg, vn, p.icd10, p.diagtype);
      audit.write({ vn, hn: '', vstdate: '', main_dep: '', dep_name: '', patient: '',
        user: session.u, userName: session.n, fields: ['diag-:' + String(p.icd10 || '').toUpperCase()] });
      return { deleted: !!r.affected, diags: await opd.diagsFull(cfg, vn) };
    }

    /* ---- งานกายภาพบำบัด (ovst_rehab / ovst_rehab_detail) ---- */
    case 'data.physiocheck': {
      const cfg = await contextFor(session);
      const from = dateOr(p.from), to = dateOr(p.to || p.from);
      const dep = p.dep ? String(p.dep) : '';
      const all = await physio.physioList(cfg, from, to, dep, 20000);
      const summary = physio.summarizePhysio(all);
      let rows = all;
      if (p.status === 'incomplete') rows = rows.filter((r) => !r._complete);
      else if (p.status === 'complete') rows = rows.filter((r) => r._complete);
      const q = String(p.q || '').trim().toLowerCase();
      if (q) {
        rows = rows.filter((r) =>
          String(r.hn || '').toLowerCase().includes(q) ||
          String(r.vn || '').toLowerCase().includes(q) ||
          String(r.ptname || '').toLowerCase().includes(q) ||
          String(r.cid || '').includes(q));
      }
      return { from, to, dep, fields: physio.META, summary, grandTotal: all.length, total: rows.length, rows: rows.slice(0, 3000) };
    }

    case 'save.physiomerge': {
      const cfg = await contextFor(session);
      const r = await physio.mergeDupRehab(cfg, Array.isArray(p.vns) ? p.vns : [], Array.isArray(p.pairs) ? p.pairs : []);
      audit.write({
        vn: '(' + r.vnCount + ' vn)', hn: '', vstdate: '', main_dep: '', dep_name: '', patient: '',
        user: session.u, userName: session.n, fields: ['physio-merge: รวม ' + r.groups + ' กลุ่ม ลบ ' + r.merged + ' แถว']
      });
      return r;
    }

    case 'save.physiofinish': {
      const cfg = await contextFor(session);
      const r = await physio.fillFinishDates(cfg, Array.isArray(p.regs) ? p.regs : []);
      audit.write({
        vn: '(' + r.requested + ' ทะเบียน)', hn: '', vstdate: '', main_dep: '', dep_name: '', patient: '',
        user: session.u, userName: session.n, fields: ['physio-finish: ตั้งวันที่สิ้นสุด = วันที่เริ่ม ' + r.updated + ' ทะเบียน']
      });
      return r;
    }

    case 'save.physiofield': {
      const cfg = await contextFor(session);
      const ctx = { src: String(p.src || 'D'), pid: p.pid, items_id: p.items, register_id: p.reg, hn: p.hn };
      const r = await physio.savePhysioField(cfg, String(p.field || ''), ctx, p.value);
      const row = await physio.getPhysioRow(cfg, String(p.src || 'D'), p.pid);
      audit.write({
        vn: row ? row.vn : '', hn: row ? row.hn : '', vstdate: row ? row.vstdate : '',
        main_dep: '', dep_name: '', patient: row ? row.ptname : '',
        user: session.u, userName: session.n, fields: ['physio:' + String(p.field || '')]
      });
      return { saved: true, value: r.value, row };
    }

    /* ---- งานฝากครรภ์ (person_anc / person_anc_service / person_anc_preg_care) ---- */
    case 'data.anccheck': {
      const cfg = await contextFor(session);
      const mode = anc.MODES[p.mode] ? String(p.mode) : 'prenatal';
      const from = dateOr(p.from), to = dateOr(p.to || p.from);
      const all = await anc.ancList(cfg, mode, from, to, 20000);
      const summary = anc.summarizeAnc(mode, all);
      let rows = all;
      if (p.status === 'incomplete') rows = rows.filter((r) => !r._complete);
      else if (p.status === 'complete') rows = rows.filter((r) => r._complete);
      const q = String(p.q || '').trim().toLowerCase();
      if (q) {
        rows = rows.filter((r) =>
          String(r.hn || '').toLowerCase().includes(q) ||
          String(r.vn || '').toLowerCase().includes(q) ||
          String(r.ptname || '').toLowerCase().includes(q) ||
          String(r.cid || '').includes(q));
      }
      return { mode, from, to, fields: anc.metaOf(mode), summary, grandTotal: all.length, total: rows.length, rows: rows.slice(0, 3000) };
    }

    case 'save.ancfield': {
      const cfg = await contextFor(session);
      const mode = anc.MODES[p.mode] ? String(p.mode) : 'prenatal';
      const ctx = p.ctx && typeof p.ctx === 'object' ? p.ctx : {};
      const r = await anc.saveAncField(cfg, mode, String(p.field || ''), ctx, p.value);
      audit.write({
        vn: String(ctx.vn || ''), hn: String(ctx.hn || ''), vstdate: '',
        main_dep: '', dep_name: '', patient: '',
        user: session.u, userName: session.n, fields: ['anc(' + mode + '):' + String(p.field || '')]
      });
      return { saved: true, value: r.value };
    }

    /* ---- ผู้ป่วยใน (ipt / iptdiag / iptoprt / opitemrece) ---- */
    case 'data.ipdcheck': {
      const cfg = await contextFor(session);
      const basis = ipd.BASIS[p.basis] ? String(p.basis) : 'stay';
      const from = dateOr(p.from), to = dateOr(p.to || p.from);
      const ward = String(p.ward || '');
      const [wards, all] = await Promise.all([
        ipd.wards(cfg, basis, from, to),
        ipd.ipdList(cfg, basis, from, to, ward, 20000)
      ]);
      const summary = ipd.summarize(all);
      let rows = all;
      if (p.status === 'incomplete') rows = rows.filter((r) => !r._complete);
      else if (p.status === 'complete') rows = rows.filter((r) => r._complete);
      if (p.miss === 'advice') rows = rows.filter((r) => r.advice_n > 0);
      else if (p.miss) rows = rows.filter((r) => r._missing.includes(String(p.miss)));
      const q = String(p.q || '').trim().toLowerCase();
      if (q) {
        rows = rows.filter((r) =>
          String(r.an || '').toLowerCase().includes(q) ||
          String(r.hn || '').toLowerCase().includes(q) ||
          String(r.ptname || '').toLowerCase().includes(q) ||
          String(r.cid || '').includes(q));
      }
      return { basis, from, to, ward, wards, fields: ipd.META, summary, grandTotal: all.length, total: rows.length, rows: rows.slice(0, 3000) };
    }

    case 'data.ipddetail': {
      const cfg = await contextFor(session);
      return { items: await ipd.detail(cfg, String(p.an || ''), String(p.kind || '')) };
    }

    case 'data.icd9': {
      const cfg = await contextFor(session);
      return { items: await ipd.searchIcd9(cfg, p.q) };
    }

    case 'save.ipdfield': {
      const cfg = await contextFor(session);
      const ctx = p.ctx && typeof p.ctx === 'object' ? p.ctx : {};
      const r = await ipd.saveField(cfg, String(p.field || ''), ctx, p.value);
      audit.write({ vn: String(ctx.an || ''), hn: String(ctx.hn || ''), vstdate: '', main_dep: '', dep_name: '', patient: '',
        user: session.u, userName: session.n, fields: ['ipd:' + String(p.field || '')] });
      return { saved: true, value: r.value, row: await ipd.getRow(cfg, String(ctx.an || '')) };
    }

    case 'ipd.diagadd': case 'ipd.diagupdate': case 'ipd.diagdelete':
    case 'ipd.procadd': case 'ipd.procupdate': case 'ipd.procdelete': {
      const cfg = await contextFor(session);
      const an = String(p.an || '');
      const kind = name.indexOf('diag') >= 0 ? 'dx' : 'proc';
      if (name === 'ipd.diagadd') await ipd.addDiag(cfg, an, p.icd10, p.diagtype, p.doctor, session.u);
      else if (name === 'ipd.diagupdate') await ipd.updateDiag(cfg, an, p.id, p.data || {});
      else if (name === 'ipd.diagdelete') await ipd.deleteDiag(cfg, an, p.id);
      else if (name === 'ipd.procadd') await ipd.addProc(cfg, an, p.data || {}, session.u);
      else if (name === 'ipd.procupdate') await ipd.updateProc(cfg, an, p.id, p.data || {});
      else await ipd.deleteProc(cfg, an, p.id);
      audit.write({ vn: an, hn: '', vstdate: '', main_dep: '', dep_name: '', patient: '',
        user: session.u, userName: session.n, fields: [name] });
      return { items: await ipd.detail(cfg, an, kind), row: await ipd.getRow(cfg, an) };
    }

    /* ---- Patient EMR (อ่านอย่างเดียว) ---- */
    case 'data.emr': {
      const cfg = await contextFor(session);
      return await emr.buildEmr(cfg, String(p.vn || ''));
    }

    case 'data.emrvisits': {
      const cfg = await contextFor(session);
      return { success: true, items: await emr.visitsOf(cfg, String(p.hn || '')) };
    }

    /* ---- ตรวจข้อมูลทันตกรรม (dental_care) ---- */
    case 'data.dentalcheck': {
      const cfg = await contextFor(session);
      const from = dateOr(p.from), to = dateOr(p.to || p.from);
      const dep = p.dep ? String(p.dep) : '';
      const all = await dental.dentalList(cfg, from, to, dep, 20000);
      const summary = dental.summarizeDental(all);
      let rows = all;
      if (p.status === 'incomplete') rows = rows.filter((r) => !r._complete);
      else if (p.status === 'complete') rows = rows.filter((r) => r._complete);
      const q = String(p.q || '').trim().toLowerCase();
      if (q) {
        rows = rows.filter((r) =>
          String(r.hn || '').toLowerCase().includes(q) ||
          String(r.vn || '').toLowerCase().includes(q) ||
          String(r.ptname || '').toLowerCase().includes(q) ||
          String(r.cid || '').includes(q));
      }
      return { from, to, dep, fields: dental.META, summary, grandTotal: all.length, total: rows.length, rows: rows.slice(0, 3000) };
    }

    case 'data.dentallookups': {
      const cfg = await contextFor(session);
      return { lookups: await dental.dentalLookups(cfg) };
    }

    case 'save.dentalfill': {
      const cfg = await contextFor(session);
      const vns = Array.isArray(p.vns) ? p.vns : [];
      const r = await dental.fillDentalDefaults(cfg, vns);
      audit.write({
        vn: '(' + r.vnCount + ' ราย)', hn: '', vstdate: '', main_dep: '', dep_name: '', patient: '',
        user: session.u, userName: session.n, fields: ['dental-fill: ' + r.affected + ' ค่า']
      });
      return r;
    }

    case 'save.dentalfield': {
      const cfg = await contextFor(session);
      const r = await dental.saveDentalField(cfg, String(p.field || ''), p.vn, p.value);
      const row = await dental.getDentalRow(cfg, String(p.vn || ''));
      audit.write({
        vn: String(p.vn || ''), hn: row ? row.hn : '', vstdate: row ? row.vstdate : '',
        main_dep: '', dep_name: '', patient: row ? row.ptname : '',
        user: session.u, userName: session.n, fields: ['dental:' + String(p.field || '')]
      });
      return { saved: true, value: r.value, row };
    }

    case 'save.field': {
      const cfg = await contextFor(session);
      const r = await opd.saveCheckField(cfg, String(p.field || ''), p.vn, p.value);
      await opd.stampAppStaff(cfg, String(p.vn || ''), session.u);   // ประทับผู้บันทึกเพิ่มเติม
      const row = await opd.getCheckRow(cfg, String(p.vn || ''));
      audit.write({
        vn: String(p.vn || ''), hn: row ? row.hn : '', vstdate: row ? row.vstdate : '',
        main_dep: '', dep_name: '', patient: row ? row.ptname : '',
        user: session.u, userName: session.n, fields: [String(p.field || '')]
      });
      return { saved: true, value: r.value, row };
    }

    case 'data.lookup': {
      const cfg = await contextFor(session);
      return {
        doctor: await opd.lookup(cfg, 'doctor'),
        pttype: await opd.lookup(cfg, 'pttype'),
        ovstost: await opd.lookup(cfg, 'ovstost')
      };
    }

    case 'data.icd10': {
      const cfg = await contextFor(session);
      return { items: await opd.searchIcd10(cfg, p.q) };
    }

    case 'data.doctors': {
      const cfg = await contextFor(session);
      return { items: await opd.searchDoctors(cfg, p.q, 30) };
    }

    case 'data.audit': {
      const from = dateOr(p.from), to = dateOr(p.to || p.from);
      return { entries: audit.read(from, to, p.dep ? String(p.dep) : '') };
    }

    /* ---- บันทึกข้อมูลเพิ่ม ---- */
    case 'save.visit': {
      const cfg = await contextFor(session);
      const vn = String(p.vn || '');
      const visit = await opd.getVisit(cfg, vn);
      if (!visit) { const e = new Error('ไม่พบข้อมูลการมารับบริการนี้'); e.status = 404; throw e; }

      const changed = [];
      const data = p.data || {};

      const screenKeys = ['bps', 'bpd', 'pulse', 'rr', 'temperature', 'bw', 'height', 'o2sat', 'cc'];
      const screenData = {};
      for (const k of screenKeys) if (data[k] !== undefined && String(data[k]).trim() !== '') screenData[k] = data[k];
      if (Object.keys(screenData).length) {
        const r = await opd.saveScreen(cfg, visit, screenData);
        if (r.affected) changed.push(...Object.keys(screenData));
      }

      const visitData = {};
      for (const k of ['pttype', 'doctor', 'ovstost']) {
        if (data[k] !== undefined && String(data[k]).trim() !== '' && String(data[k]) !== String(visit[k] || '')) visitData[k] = data[k];
      }
      if (Object.keys(visitData).length) {
        const r = await opd.saveVisitFields(cfg, vn, visitData);
        if (r.affected) changed.push(...Object.keys(visitData));
      }

      if (data.icd10 && String(data.icd10).trim()) {
        const r = await opd.addDiag(cfg, visit, data.icd10, data.diagtype || '1', data.doctor || visit.doctor, session.u);
        if (r.affected) changed.push('icd10:' + String(data.icd10).toUpperCase());
        else if (r.duplicated) changed.push('icd10-ซ้ำ');
      }

      if (changed.length) {
        await opd.stampAppStaff(cfg, vn, session.u);   // ประทับผู้บันทึกเพิ่มเติม เมื่อมีการบันทึกจริง
        audit.write({
          vn, hn: visit.hn, vstdate: visit.vstdate, main_dep: String(visit.main_dep || ''),
          dep_name: visit.dep_name, patient: visit.full_name,
          user: session.u, userName: session.n, fields: changed
        });
      }

      const after = await opd.getVisit(cfg, vn);
      return { changed, visit: after, diags: await opd.diagsOf(cfg, vn) };
    }

    default: {
      const e = new Error('ไม่รู้จักคำสั่งนี้'); e.status = 404; throw e;
    }
  }
}

/* ---------------- ปลายทางอื่น ---------------- */
app.get('/health', (req, res) => {
  const c = cfgStore.load();
  res.json({ ok: true, service: 'Fullfill OPD', port: Number(PORT), configured: !!(c.host && c.token) });
});

app.use((req, res) => fail(res, 404, 'ไม่พบปลายทางที่ร้องขอ'));

app.listen(PORT, () => {
  const c = cfgStore.load();
  console.log('');
  console.log('  ระบบตรวจสอบความสมบูรณ์การลงข้อมูลผู้รับบริการ OPD');
  console.log('  ------------------------------------------------');
  console.log('  URL       : http://localhost:' + PORT);
  console.log('  ฐานข้อมูล  : ' + (c.host ? c.driver + ' @ ' + c.host + ':' + c.port + '/' + c.database : 'ยังไม่ได้ตั้งค่า'));
  console.log('  Token     : ' + (c.token ? c.token.slice(0, 5) + '**********' : 'ยังไม่ได้สร้าง'));
  console.log('');
});

process.on('SIGINT', async () => { await db.closeAll(); process.exit(0); });
