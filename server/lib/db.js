'use strict';
/** ชั้นเชื่อมต่อฐานข้อมูล รองรับ MySQL / MariaDB, PostgreSQL และ BMS API tunnel */
const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const bms = require('./bms');

let pool = null;
let poolKey = '';
let poolDriver = '';

const keyOf = (c) => [c.driver, c.host, c.port, c.database, c.username, c.password].join('|');

/** แปลง placeholder ? -> $1,$2 สำหรับ PostgreSQL */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

async function makePool(c) {
  if (c.driver === 'postgres') {
    // ไม่ตั้ง statement_timeout เป็น startup parameter เพราะ PgBouncer (transaction/statement pooling)
    // จะปฏิเสธด้วย error 08P01: unsupported startup parameter
    const pool = new Pool({
      host: c.host, port: Number(c.port) || 5432, database: c.database,
      user: c.username, password: c.password,
      max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 12000,
      keepAlive: true
    });
    // client ที่ว่างอยู่ใน pool ถูกฝั่ง DB/PgBouncer ตัด → ถ้าไม่ดัก error นี้ Node จะ crash ทั้งโปรเซส
    // pool จะทิ้ง client ตัวนั้นเองและเปิดใหม่เมื่อมี query ถัดไป
    pool.on('error', (err) => console.warn('[db] idle client error:', err.message));
    return pool;
  }
  return mysql.createPool({
    host: c.host, port: Number(c.port) || 3306, database: c.database,
    user: c.username, password: c.password,
    waitForConnections: true, connectionLimit: 8, queueLimit: 0,
    connectTimeout: 12000, charset: 'utf8mb4_general_ci',
    dateStrings: true, timezone: 'local', multipleStatements: false
  });
}

async function getPool(cfg) {
  const k = keyOf(cfg);
  if (pool && poolKey === k) return pool;
  if (pool) { try { await pool.end(); } catch (e) {} pool = null; }
  pool = await makePool(cfg);
  poolKey = k;
  poolDriver = cfg.driver;
  return pool;
}

/** รันคำสั่ง SELECT คืน array ของแถว */
async function query(cfg, sql, params) {
  if (cfg.bms) return bms.executeSql(cfg.bms, sql, params);   // เข้าระบบด้วย BMS session → ผ่าน API tunnel
  const p = await getPool(cfg);
  if (cfg.driver === 'postgres') {
    const r = await p.query(toPg(sql), params || []);
    return r.rows;
  }
  const [rows] = await p.query(sql, params || []);
  return rows;
}

/** รันคำสั่ง INSERT/UPDATE คืนจำนวนแถวที่เปลี่ยน */
async function execute(cfg, sql, params) {
  if (cfg.bms) {
    const rows = await bms.executeSql(cfg.bms, sql, params);
    // API tunnel ไม่คืน affectedRows; ถือว่าสำเร็จเมื่อไม่ throw
    const n = (rows && rows[0] && (rows[0].affected_rows || rows[0].row_count));
    return { affected: n !== undefined && n !== null ? Number(n) : 1 };
  }
  const p = await getPool(cfg);
  if (cfg.driver === 'postgres') {
    const r = await p.query(toPg(sql), params || []);
    return { affected: r.rowCount || 0 };
  }
  const [res] = await p.query(sql, params || []);
  return { affected: res.affectedRows || 0 };
}

/** ทดสอบการเชื่อมต่อ + ตรวจตารางที่จำเป็น */
async function testConnection(c) {
  let tmp = null;
  const started = Date.now();
  try {
    tmp = await makePool(c);
    let version = '', dbname = '';
    if (c.driver === 'postgres') {
      const r = await tmp.query('SELECT version() AS v, current_database() AS d');
      version = r.rows[0].v; dbname = r.rows[0].d;
    } else {
      const [r] = await tmp.query('SELECT VERSION() AS v, DATABASE() AS d');
      version = r[0].v; dbname = r[0].d;
    }
    const need = ['officer', 'ovst', 'kskdepartment', 'patient', 'opdscreen'];
    const found = [];
    for (const t of need) {
      try {
        if (c.driver === 'postgres') await tmp.query('SELECT 1 FROM ' + t + ' LIMIT 1');
        else await tmp.query('SELECT 1 FROM `' + t + '` LIMIT 1');
        found.push(t);
      } catch (e) { /* ไม่มีตารางนี้ */ }
    }
    return {
      ok: true, elapsed: Date.now() - started,
      version: String(version).split('\n')[0], database: dbname,
      tables: found, missing: need.filter((t) => !found.includes(t))
    };
  } catch (err) {
    return { ok: false, error: err.code ? err.code + ': ' + err.message : err.message };
  } finally {
    if (tmp) { try { await tmp.end(); } catch (e) {} }
  }
}

async function closeAll() {
  if (pool) { try { await pool.end(); } catch (e) {} pool = null; poolKey = ''; }
}

module.exports = { query, execute, testConnection, closeAll, toPg, get driver() { return poolDriver; } };
