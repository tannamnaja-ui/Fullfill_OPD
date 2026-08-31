# ระบบตรวจสอบความสมบูรณ์การลงข้อมูลผู้รับบริการ OPD

ระบบตรวจสอบและเติมข้อมูลผู้รับบริการผู้ป่วยนอก (OPD) สำหรับฐานข้อมูล HOSxP
ธีมสีม่วงอ่อนพาสเทล ใช้งานที่ **http://localhost:3006**

---

## การติดตั้งและเริ่มใช้งาน

```bash
npm install
npm start
```

หรือดับเบิลคลิก **`start.bat`** (Windows) แล้วเปิดเบราว์เซอร์ไปที่ http://localhost:3006

> ต้องมี Node.js 18 ขึ้นไป (ทดสอบบน Node 24)

---

## ขั้นตอนการใช้งานครั้งแรก

### 1. ตั้งค่าการเชื่อมต่อ
ที่หน้า Login กดปุ่ม **⚙️ ตั้งค่าการเชื่อมต่อ**
- เลือกชนิดฐานข้อมูล **MySQL / MariaDB** หรือ **PostgreSQL**
- กรอก **IP Server, Port, Database, Username, Password**
- กรอก **รหัสสถานพยาบาล** แล้วกด **🔄 สร้าง** เพื่อสร้าง Token
  (Token = รหัสสถานพยาบาล + รหัสสุ่ม 10 หลัก เช่น `10670ABCDEFGHJK`)
- กด **🔍 ทดสอบการเชื่อมต่อ** เพื่อตรวจสอบ
- กด **💾 บันทึกข้อมูลเชื่อมต่อ** → ระบบเด้งกลับหน้า Login และ**จำค่าที่ตั้งไว้**

### 2. เข้าสู่ระบบ (2 ทางเลือก)

**ก) ด้วยบัญชี HOSxP (officer)** — ใช้ฐานข้อมูลที่ตั้งค่าเชื่อมต่อไว้
- Username = `officer.officer_login_name`
- Password = ตรวจสอบกับ `officer.officer_login_password_md5` (ถอด MD5 อัตโนมัติ)

**ข) ด้วย BMS Session** — ไม่ต้องใส่ username/password (อ้างอิง `BMS-SESSION-SPECIFICATION.md`)
- เปิดจากลิงก์ที่มี `?bms-session-id=XXXX` → ระบบตรวจสอบและ**เข้าโปรแกรมให้อัตโนมัติ**
- หรือวาง Session ID ในช่อง “เข้าสู่ระบบด้วย BMS Session” ที่หน้า Login แล้วกด 🔗 เชื่อม
- ระบบจะเรียก HOSxP `PasteJSON` เพื่อดึงข้อมูลผู้ใช้ + config แล้ว**รันข้อมูลทั้งหมดผ่าน HOSxP API tunnel** (`/api/sql` + Bearer token) — จึงใช้งานได้แม้ยังไม่ตั้งค่าฐานข้อมูลโดยตรง
- Session ถูกจำไว้ใน cookie 7 วัน (กด “ออกจากระบบ” เพื่อล้าง)

> ตั้งค่า URL ของ PasteJSON ได้ผ่าน env `BMS_PASTEJSON_URL` (ค่าเริ่มต้น `https://hosxp.net/phapi/PasteJSON`) และแท็กแอปผ่าน `BMS_APP_TAG`

### 3. เมนูการทำงาน (หลัง Login)
| เมนู | รายละเอียด |
|------|-----------|
| **📊 แดชบอร์ดข้อมูลที่ลงเพิ่ม** | เลือกวันที่ + จุดบริการ ดูภาพรวมความสมบูรณ์รายจุดบริการ/รายการ และประวัติข้อมูลที่ลงเพิ่มผ่านระบบ |
| **📝 ตรวจสอบและเพิ่มข้อมูล** | เลือกวันที่ + จุดบริการ แสดงตารางตามคิวรี่ที่กำหนด — 9 ช่องที่ยังว่าง (hospmain, pttypeno, pdx, cc, bps, bpd, temperature, bw, bmi) จะเป็น **สีแดง แก้ในช่องได้ทันที** กด Enter แล้ว**บันทึกกลับเข้าฟิลด์เดิม**ทันที |

### ตารางหน้า “ตรวจสอบและเพิ่มข้อมูล” — ฟิลด์ที่แก้ไขได้ (บันทึกกลับฟิลด์เดิม)
| ช่องบนตาราง | เขียนกลับไปที่ |
|-------------|----------------|
| รพ.หลัก (hospmain) | `vn_stat.hospmain` |
| เลขที่สิทธิ (pttypeno) | `ovst.pttypeno` |
| วินิจฉัยหลัก Pdx | `vn_stat.pdx` (ค้นหา ICD-10 อัตโนมัติ) |
| อาการสำคัญ CC | `opdscreen.cc` |
| SBP / DBP | `opdscreen.bps` / `opdscreen.bpd` |
| อุณหภูมิ / น้ำหนัก / BMI | `opdscreen.temperature` / `bw` / `bmi` |

> รองรับทั้ง PostgreSQL (`VARCHAR`) และ MySQL (`CHAR`) อัตโนมัติ; กรอง `o.an is null` (เฉพาะ OPD) ตามคิวรี่

จุดบริการดึงจาก `ovst.main_dep` ตามวันที่ที่เลือก แล้วเทียบชื่อกับ `kskdepartment` (group by `ovst.main_dep`)

---

## ความปลอดภัย (ตามข้อกำหนด)

| ข้อกำหนด | การทำงาน |
|----------|----------|
| **API ใช้ token ตอบกลับ** | ทุก request/response ถูกเข้ารหัส (SHA-256 stream cipher + HMAC) ด้วยกุญแจที่ได้จาก Token — ถ้าไม่มี Token ที่ถูกต้อง จะไม่มีข้อมูลส่งกลับ |
| **เข้ารหัสเส้น API** | เส้นทางจริงถูกแปลงเป็นรหัส 24 หลัก (`/q/<hmac>`) หน้าจอเรียกด้วยชื่อเชิงตรรกะ ผู้ใช้มองไม่เห็นเส้นทางจริง |
| **Token ต่อโรงพยาบาล** | สร้างที่หน้าตั้งค่า ขึ้นต้นด้วยรหัสสถานพยาบาล + 10 หลัก |
| **กัน copy URL ไปยิง Postman** | ต้องส่ง Token ใน header `X-API-Token` และเข้ารหัส payload ให้ถูกต้องก่อน จึงจะได้ข้อมูล มิฉะนั้นตอบ 401/403 |
| **ปกปิดรหัสผ่าน** | รหัสผ่านฐานข้อมูลถูกเข้ารหัส AES-256 ในไฟล์ `config/connection.json` และแสดงเป็น `********` บนหน้าจอ |

การป้องกันเพิ่มเติม: จำกัดจำนวนครั้ง login ที่ผิด, session มีลายเซ็นและหมดอายุใน 8 ชั่วโมง

---

## เกณฑ์ความสมบูรณ์ (12 รายการ)
เลขบัตรประชาชน · สิทธิการรักษา · ผู้ให้บริการ/แพทย์ · สถานะ/ผลการรักษา · อาการสำคัญ (CC) ·
ความดันโลหิต · ชีพจร · อัตราการหายใจ · อุณหภูมิ · น้ำหนัก/ส่วนสูง · การวินิจฉัย (ICD-10) · ยา/หัตถการ/ค่าบริการ

---

## โครงสร้างโปรเจค
```
server/
  index.js          เซิร์ฟเวอร์ Express + เราต์เตอร์ API ที่เข้ารหัส
  lib/
    secure.js       เข้ารหัส payload / เส้นทาง / token / session (ฝั่ง server)
    config.js       จัดเก็บค่าการเชื่อมต่อ (เข้ารหัสรหัสผ่าน)
    db.js           เชื่อมต่อ MySQL / PostgreSQL
    auth.js         ตรวจสอบผู้ใช้จากตาราง officer
    bms.js          เข้าสู่ระบบด้วย BMS session + รัน SQL ผ่าน HOSxP API tunnel
    db.js           สลับ backend อัตโนมัติ: DB ตรง หรือ BMS API tunnel
    opd.js          SQL + กฎความสมบูรณ์ OPD
    audit.js        บันทึกประวัติข้อมูลที่ลงเพิ่ม
public/
  login.html        หน้า Login + ตั้งค่าการเชื่อมต่อ
  index.html        หน้าหลัก (เมนูซ้าย + 2 หน้า)
  css/theme.css     ธีมม่วงพาสเทล
  js/
    crypto.js       เข้ารหัสฝั่ง browser (ตรงกับ server)
    api.js          ตัวเรียก API
    ui.js, login.js, app.js
tools/
  smoke.js          ทดสอบความปลอดภัย/flow (DB login) ผ่าน HTTP
  logic-test.js     ทดสอบตรรกะ query/ประเมิน/บันทึก (mock DB)
  mock-hosxp.js     จำลอง HOSxP API (PasteJSON + /api/sql) สำหรับทดสอบ BMS
  bms-smoke.js      ทดสอบ BMS session login + ดึง/บันทึกข้อมูลผ่าน tunnel
```

## ตาราง HOSxP ที่ใช้
`officer`, `ovst`, `patient`, `opdscreen`, `ovstdiag`, `opitemrec`, `kskdepartment`, `doctor`, `pttype`, `ovstost`, `icd101`

## ทดสอบ
```bash
# ทดสอบความปลอดภัย + flow แบบ DB login
npm start
node tools/smoke.js
node tools/logic-test.js

# ทดสอบ BMS session login (ผ่าน HOSxP API tunnel จำลอง)
node tools/mock-hosxp.js                                        # เทอร์มินัล 1
BMS_PASTEJSON_URL="http://127.0.0.1:4099/phapi/PasteJSON" npm start   # เทอร์มินัล 2
node tools/bms-smoke.js                                         # เทอร์มินัล 3
```
