'use strict';
/** จัดเก็บ/อ่านค่าการเชื่อมต่อฐานข้อมูล (จำค่าที่ตั้งไว้) */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'connection.json');
const SECRET_FILE = path.join(CONFIG_DIR, '.secret');

const DEFAULT = {
  driver: 'mysql',
  host: '127.0.0.1',
  port: 3306,
  database: 'hos',
  username: 'sa',
  password: '',
  hospCode: '',
  token: '',
  updatedAt: null
};

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

/** secret ประจำเครื่อง ใช้ทำ route id + เข้ารหัสรหัสผ่านใน config */
function appSecret() {
  ensureDir();
  if (!fs.existsSync(SECRET_FILE)) {
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(48).toString('hex'), 'utf8');
  }
  return fs.readFileSync(SECRET_FILE, 'utf8').trim();
}

const keyOf = () => crypto.createHash('sha256').update('cfg|' + appSecret()).digest();

function encField(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', keyOf(), iv);
  return 'enc:' + iv.toString('hex') + ':' + Buffer.concat([c.update(String(plain), 'utf8'), c.final()]).toString('hex');
}

function decField(v) {
  if (!v || typeof v !== 'string' || !v.startsWith('enc:')) return v || '';
  try {
    const [, ivHex, dataHex] = v.split(':');
    const d = crypto.createDecipheriv('aes-256-cbc', keyOf(), Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
  } catch (e) { return ''; }
}

let cache = null;

function load() {
  if (cache) return cache;
  ensureDir();
  let raw = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { raw = {}; }
  }
  cache = Object.assign({}, DEFAULT, raw);
  cache.password = decField(cache.password);
  return cache;
}

function save(cfg) {
  ensureDir();
  const cur = load();
  const next = Object.assign({}, cur, cfg, { updatedAt: new Date().toISOString() });
  next.port = parseInt(next.port, 10) || (next.driver === 'postgres' ? 5432 : 3306);
  cache = next;
  const onDisk = Object.assign({}, next, { password: encField(next.password) });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(onDisk, null, 2), 'utf8');
  return next;
}

/** ค่าที่ส่งกลับหน้าจอ (ปกปิดรหัสผ่านจริงด้วย placeholder) */
function publicView() {
  const c = load();
  return {
    driver: c.driver, host: c.host, port: c.port, database: c.database,
    username: c.username, password: c.password ? '********' : '',
    hospCode: c.hospCode, token: c.token, updatedAt: c.updatedAt,
    configured: !!(c.host && c.database && c.username && c.token)
  };
}

module.exports = { load, save, publicView, appSecret, DEFAULT, CONFIG_FILE };
