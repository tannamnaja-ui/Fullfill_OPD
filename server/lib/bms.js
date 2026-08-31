'use strict';
/**
 * BMS Session — เข้าสู่ระบบด้วย bms-session-id
 * อ้างอิง BMS-SESSION-SPECIFICATION.md
 *
 *  1) retrieveSession(id): เรียก HOSxP PasteJSON เพื่อดึง user_info + config การเชื่อมต่อ
 *  2) executeSql(api, sql): รัน SQL ผ่าน HOSxP API tunnel  ({apiUrl}/api/sql, Bearer auth)
 *
 * เมื่อเข้าระบบด้วย BMS session ข้อมูลทั้งหมดจะวิ่งผ่าน API นี้แทนการต่อฐานข้อมูลโดยตรง
 * จึงไม่ต้องกรอก username / password
 */
const PASTE_JSON_URL = process.env.BMS_PASTEJSON_URL || 'https://hosxp.net/phapi/PasteJSON';
const APP_TAG = process.env.BMS_APP_TAG || 'BMS.Dashboard.React';
const TIMEOUT_MS = 30000;

/** fetch ที่มี timeout */
async function fetchT(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ดึงข้อมูล session จาก HOSxP
 * @returns {Promise<{ok, expired?, error?, api?, user?}>}
 */
async function retrieveSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return { ok: false, error: 'ไม่ได้ระบุ BMS Session ID' };

  let res, body;
  try {
    const url = PASTE_JSON_URL + '?Action=GET&code=' + encodeURIComponent(id);
    res = await fetchT(url, { method: 'GET', headers: { Accept: 'application/json' } });
    const text = await res.text();
    try { body = JSON.parse(text); } catch (e) { body = null; }
  } catch (err) {
    return { ok: false, error: 'เชื่อมต่อ HOSxP API ไม่สำเร็จ: ' + (err.name === 'AbortError' ? 'หมดเวลา' : err.message) };
  }

  if (!body) return { ok: false, error: 'รูปแบบข้อมูล session ไม่ถูกต้อง' };

  const code = Number(body.MessageCode);
  if (code === 500) return { ok: false, expired: true, error: 'BMS Session หมดอายุ กรุณาเข้าสู่ระบบใหม่' };
  if (code !== 200) return { ok: false, error: body.Message || ('ตรวจสอบ session ไม่สำเร็จ (code ' + code + ')') };

  const result = body.result || {};
  const kv = result.key_value || {};
  const ui = result.user_info || {};

  const apiUrl = kv['hosxp.api_url'] || ui['hosxp.api_url'] || ui.bms_url || '';
  const authKey = kv['hosxp.api_auth_key'] || ui['hosxp.api_auth_key'] || ui.bms_session_code || '';

  if (!apiUrl || !authKey) {
    return { ok: false, error: 'ไม่พบข้อมูลการเชื่อมต่อ (api_url / auth_key) ใน session' };
  }

  return {
    ok: true,
    api: { apiUrl: String(apiUrl).replace(/\/+$/, ''), authKey: String(authKey), sessionId: id },
    user: {
      username: ui.doctor_code || ui.bms_session_code || id.slice(0, 8),
      name: ui.name || 'ผู้ใช้ BMS',
      officerId: ui.doctor_code || '',
      position: 'เข้าระบบด้วย BMS Session',
      location: ui.location || ''
    }
  };
}

/* ---------- แปลงพารามิเตอร์เป็น literal อย่างปลอดภัย (สำหรับ MySQL/MariaDB) ---------- */
function escapeStr(s) {
  return String(s).replace(/[\0\b\t\n\r\x1a\\'"]/g, function (ch) {
    switch (ch) {
      case '\0': return '\\0';
      case '\b': return '\\b';
      case '\t': return '\\t';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\x1a': return '\\Z';
      case '"': return '\\"';
      case "'": return "\\'";
      case '\\': return '\\\\';
      default: return ch;
    }
  });
}

function toLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return "'" + escapeStr(v) + "'";
}

/** แทนที่ ? ด้วยค่าพารามิเตอร์ที่ escape แล้ว (ตามลำดับ) */
function inlineParams(sql, params) {
  const list = params || [];
  let i = 0;
  return sql.replace(/\?/g, function () {
    if (i >= list.length) return '?';
    return toLiteral(list[i++]);
  });
}

/** ย่อ SQL (ลบคอมเมนต์/ช่องว่างเกิน) ก่อนส่ง */
function minify(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * รัน SQL ผ่าน HOSxP API
 * @returns {Promise<Array>} แถวข้อมูล (throw เมื่อผิดพลาด)
 */
async function executeSql(api, sql, params) {
  const finalSql = minify(inlineParams(sql, params));
  const url = api.apiUrl + '/api/sql?sql=' + encodeURIComponent(finalSql) + '&app=' + encodeURIComponent(APP_TAG);

  let res, text;
  try {
    res = await fetchT(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + api.authKey, Accept: 'application/json' }
    });
    text = await res.text();
  } catch (err) {
    throw new Error('เรียก HOSxP API ไม่สำเร็จ: ' + (err.name === 'AbortError' ? 'หมดเวลา (30 วินาที)' : err.message));
  }

  if (res.status === 401) throw new Error('BMS Session ไม่ได้รับอนุญาต (401) — auth key ไม่ถูกต้องหรือหมดอายุ');
  if (res.status === 502) throw new Error('เชื่อมต่อ tunnel ของโรงพยาบาลไม่ได้ (502)');

  let body;
  try { body = JSON.parse(text); } catch (e) { throw new Error('ผลลัพธ์จาก API ไม่ใช่ JSON'); }

  const code = Number(body.MessageCode);
  if (code === 500) { const e = new Error('BMS Session หมดอายุ'); e.expired = true; throw e; }
  if (code !== 200) throw new Error(body.Message || ('API ตอบกลับผิดพลาด (code ' + code + ')'));

  return Array.isArray(body.data) ? body.data : [];
}

/** ทดสอบการเชื่อมต่อ API */
async function testApi(api) {
  const rows = await executeSql(api, 'SELECT VERSION() AS v', []);
  return rows[0] ? String(rows[0].v || rows[0].VERSION || '') : '';
}

module.exports = { retrieveSession, executeSql, testApi, inlineParams, minify, PASTE_JSON_URL };
