/* จำลอง HOSxP API: PasteJSON (ตรวจ session) + /api/sql (รัน SQL ผ่าน tunnel) */
'use strict';
const http = require('http');
const url = require('url');

const PORT = process.env.MOCK_PORT || 4099;
const VALID_SESSION = 'BMS-TEST-SESSION-123';
const AUTH_KEY = 'bearer-key-abcdef';

// ตารางจำลอง (HOSxP-like)
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
  opitemrec: { V2: [{}, {}] },
  doctor: [{ code: 'D1', name: 'นพ.ทดสอบ' }],
  pttype: [{ code: '89', name: 'บัตรทอง' }],
  ovstost: [{ code: '1', name: 'เสร็จสิ้น' }],
  icd101: [{ code: 'J00', name: 'โรคหวัด' }, { code: 'J069', name: 'การติดเชื้อทางเดินหายใจส่วนบน' }]
};

/** parser SQL แบบหยาบ ๆ พอให้ opd.js ทำงานได้ (mock เท่านั้น) */
function runSql(sql) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (/^SELECT VERSION\(\)/i.test(s)) return [{ v: '10.6.16-MariaDB (mock)' }];

  // departments
  if (/GROUP BY o\.main_dep/i.test(s)) {
    const m = s.match(/BETWEEN '([^']+)' AND '([^']+)'/);
    const from = m[1], to = m[2];
    const map = {};
    T.ovst.filter((o) => o.vstdate >= from && o.vstdate <= to).forEach((o) => { map[o.main_dep] = (map[o.main_dep] || 0) + 1; });
    return Object.keys(map).map((d) => ({ dep_code: d, dep_name: T.ksk[d] || ('จุดบริการ ' + d), visit_count: map[d] }))
      .sort((a, b) => b.visit_count - a.visit_count);
  }

  // exists opdscreen
  let m = s.match(/SELECT vn FROM opdscreen WHERE vn = '([^']+)'/i);
  if (m) return T.opdscreen[m[1]] ? [{ vn: m[1] }] : [];

  // dup ovstdiag
  m = s.match(/SELECT vn FROM ovstdiag WHERE vn = '([^']+)' AND icd10 = '([^']+)'/i);
  if (m) return (T.ovstdiag[m[1]] || []).some((d) => d.icd10 === m[2]) ? [{ vn: m[1] }] : [];

  // diags of vn
  m = s.match(/FROM ovstdiag d LEFT JOIN icd101 i ON i\.code = d\.icd10 WHERE d\.vn = '([^']+)'/i);
  if (m) return (T.ovstdiag[m[1]] || []).map((d) => ({ icd10: d.icd10, diagtype: d.diagtype, name: (T.icd101.find((x) => x.code === d.icd10) || {}).name || '' }));

  // lookups
  if (/FROM doctor/i.test(s)) return T.doctor.map((d) => ({ code: d.code, name: d.name }));
  if (/FROM pttype/i.test(s)) return T.pttype.map((d) => ({ code: d.code, name: d.name }));
  if (/FROM ovstost/i.test(s)) return T.ovstost.map((d) => ({ code: d.code, name: d.name }));

  // icd10 search
  m = s.match(/FROM icd101 WHERE code LIKE '%([^%]*)%'/i);
  if (m) { const q = m[1].toLowerCase(); return T.icd101.filter((x) => x.code.toLowerCase().includes(q) || x.name.toLowerCase().includes(q)); }

  // visits / getVisit
  if (/FROM ovst o LEFT JOIN patient/i.test(s)) {
    let rows = T.ovst.slice();
    let mm = s.match(/o\.vn = '([^']+)'/i);
    if (mm) rows = rows.filter((o) => o.vn === mm[1]);
    else {
      const b = s.match(/BETWEEN '([^']+)' AND '([^']+)'/);
      if (b) rows = rows.filter((o) => o.vstdate >= b[1] && o.vstdate <= b[2]);
      const dep = s.match(/o\.main_dep = '([^']+)'/i);
      if (dep) rows = rows.filter((o) => o.main_dep === dep[1]);
    }
    return rows.map((o) => {
      const p = T.patient[o.hn] || {};
      const sc = T.opdscreen[o.vn] || {};
      return Object.assign({}, o, p, sc, {
        dep_name: T.ksk[o.main_dep] || ('จุดบริการ ' + o.main_dep),
        dx_count: (T.ovstdiag[o.vn] || []).length,
        item_count: (T.opitemrec[o.vn] || []).length
      });
    });
  }

  // writes
  m = s.match(/^INSERT INTO opdscreen \(([^)]+)\) VALUES \((.+)\)$/i);
  if (m) {
    const cols = m[1].split(',').map((c) => c.trim());
    const vals = splitVals(m[2]);
    const row = {}; cols.forEach((c, i) => { row[c] = unquote(vals[i]); });
    T.opdscreen[row.vn] = Object.assign(T.opdscreen[row.vn] || {}, row);
    return [{ affected_rows: 1 }];
  }
  m = s.match(/^UPDATE opdscreen SET (.+) WHERE vn = '([^']+)'$/i);
  if (m) { applySet(T.opdscreen[m[2]] = T.opdscreen[m[2]] || {}, m[1]); return [{ affected_rows: 1 }]; }

  m = s.match(/^UPDATE ovst SET (.+) WHERE vn = '([^']+)'$/i);
  if (m) { const o = T.ovst.find((x) => x.vn === m[2]); if (o) applySet(o, m[1]); return [{ affected_rows: 1 }]; }

  m = s.match(/^INSERT INTO ovstdiag \(([^)]+)\) VALUES \((.+)\)$/i);
  if (m) {
    const cols = m[1].split(',').map((c) => c.trim());
    const vals = splitVals(m[2]);
    const row = {}; cols.forEach((c, i) => { row[c] = unquote(vals[i]); });
    (T.ovstdiag[row.vn] = T.ovstdiag[row.vn] || []).push({ icd10: row.icd10, diagtype: row.diagtype });
    return [{ affected_rows: 1 }];
  }

  return [];
}

function splitVals(s) {
  const out = []; let cur = ''; let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (ch === '\\') { cur += ch + s[++i]; continue; } if (ch === "'") { inStr = false; } cur += ch; }
    else { if (ch === "'") { inStr = true; cur += ch; } else if (ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function unquote(v) {
  v = v.trim();
  if (v === 'NULL') return null;
  if (v[0] === "'") return v.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
  return isNaN(Number(v)) ? v : Number(v);
}
function applySet(obj, setClause) {
  splitVals(setClause).forEach((pair) => {
    const eq = pair.indexOf('=');
    const k = pair.slice(0, eq).trim();
    obj[k] = unquote(pair.slice(eq + 1));
  });
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  if (u.pathname === '/phapi/PasteJSON') {
    const code = u.query.code;
    res.setHeader('Content-Type', 'application/json');
    if (code !== VALID_SESSION) {
      return res.end(JSON.stringify({ MessageCode: 500, Message: 'Session expired or not found' }));
    }
    return res.end(JSON.stringify({
      MessageCode: 200, Message: 'OK',
      result: {
        user_info: { name: 'นพ.บีเอ็มเอส ทดสอบ', location: 'รพ.ทดสอบ BMS', doctor_code: 'D1', bms_session_code: code },
        key_value: { 'hosxp.api_url': 'http://127.0.0.1:' + PORT, 'hosxp.api_auth_key': AUTH_KEY }
      }
    }));
  }

  if (u.pathname === '/api/sql') {
    res.setHeader('Content-Type', 'application/json');
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + AUTH_KEY) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ MessageCode: 401, Message: 'Unauthorized' }));
    }
    try {
      const data = runSql(String(u.query.sql || ''));
      return res.end(JSON.stringify({ result: {}, MessageCode: 200, Message: 'OK', data }));
    } catch (e) {
      return res.end(JSON.stringify({ MessageCode: 400, Message: e.message, data: [] }));
    }
  }

  res.statusCode = 404;
  res.end('not found');
});

server.listen(PORT, () => {
  console.log('mock HOSxP listening on http://127.0.0.1:' + PORT);
  console.log('  session id :', VALID_SESSION);
});
