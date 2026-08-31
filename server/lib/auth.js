'use strict';
/** ยืนยันตัวตนจากตาราง officer ของฐานข้อมูลที่เชื่อมต่อ */
const db = require('./db');
const { md5 } = require('./secure');

/** เทียบรหัสผ่านกับค่า md5 ที่เก็บไว้ (officer_login_password_md5) */
function passwordMatches(input, storedMd5, storedPlain) {
  const stored = String(storedMd5 || '').trim().toLowerCase();
  const raw = String(input === null || input === undefined ? '' : input);

  if (stored) {
    const candidates = [
      md5(raw),                       // md5 ของรหัสผ่านที่กรอก
      md5(raw.toUpperCase()),         // บางระบบเก็บเป็นตัวพิมพ์ใหญ่
      md5(raw.toLowerCase()),
      md5(raw.trim())
    ];
    if (candidates.some((c) => c.toLowerCase() === stored)) return true;
    // เผื่อกรณีเก็บเป็น md5 อยู่แล้ว (ผู้ใช้วาง hash มาเอง)
    if (raw.trim().toLowerCase() === stored) return true;
  }

  // สำรอง: บางฐานข้อมูลเก็บรหัสผ่านแบบข้อความในคอลัมน์ password
  if (!stored && storedPlain) {
    if (String(storedPlain) === raw) return true;
  }
  return false;
}

/** อ่านค่าจากแถวโดยไม่สนตัวพิมพ์เล็ก/ใหญ่ของชื่อคอลัมน์ */
function pick(row, names) {
  const lower = {};
  for (const k of Object.keys(row)) lower[k.toLowerCase()] = row[k];
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v !== undefined && v !== null && String(v) !== '') return v;
  }
  return '';
}

/**
 * ตรวจสอบผู้ใช้
 * @returns {Promise<{ok:boolean, user?:object, reason?:string}>}
 */
async function login(cfg, username, password) {
  const uname = String(username || '').trim();
  if (!uname) return { ok: false, reason: 'กรุณาระบุชื่อผู้ใช้' };

  let rows;
  try {
    rows = await db.query(cfg,
      'SELECT * FROM officer WHERE officer_login_name = ? LIMIT 1', [uname]);
  } catch (err) {
    return { ok: false, reason: 'เชื่อมต่อฐานข้อมูลไม่สำเร็จ: ' + (err.message || err), dbError: true };
  }

  if (!rows.length) return { ok: false, reason: 'ไม่พบชื่อผู้ใช้นี้ในตาราง officer' };

  const row = rows[0];
  const storedMd5 = pick(row, ['officer_login_password_md5']);
  const storedPlain = pick(row, ['officer_login_password', 'password']);

  if (!storedMd5 && !storedPlain) {
    return { ok: false, reason: 'บัญชีนี้ยังไม่ได้ตั้งรหัสผ่านในระบบ HOSxP' };
  }
  if (!passwordMatches(password, storedMd5, storedPlain)) {
    return { ok: false, reason: 'รหัสผ่านไม่ถูกต้อง' };
  }

  return {
    ok: true,
    user: {
      username: uname,
      officerId: String(pick(row, ['officer_id', 'code', 'id']) || ''),
      name: String(pick(row, ['name', 'officer_name', 'fname']) || uname),
      position: String(pick(row, ['position', 'positionname', 'position_name']) || ''),
      department: String(pick(row, ['department', 'dep_name', 'depcode']) || '')
    }
  };
}

module.exports = { login, passwordMatches };
