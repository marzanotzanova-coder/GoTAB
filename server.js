process.env.TZ = "Asia/Almaty";
require("dotenv").config();

// server.js (GoTAB LMS Core - WORKING FULL)
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
  
  async function uploadBufferToSupabaseStorage(bucket, filePath, buffer, contentType) {
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${filePath}`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": contentType || "application/octet-stream",
      "x-upsert": "true"
    },
    body: buffer
  });

  const data = await r.text().catch(() => "");

  if (!r.ok) {
    throw new Error(`Supabase storage upload failed: ${r.status} ${data}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${filePath}`;
}

const avatarStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dest = path.join(__dirname, "uploads", "avatars");
    ensureDir(dest);
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || "") || ".jpg";
    const name = "avatar_" + Date.now() + ext;
    cb(null, name);
  }
});

const uploadAvatar = multer({ storage: avatarStorage });

console.log("RUNNING FILE =", __filename);
console.log("CWD =", process.cwd());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===================== MIDDLEWARE =====================
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json({ limit: "10mb" })); // feedback text etc.

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20
});

app.use("/api/auth/login", loginLimiter);

app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.set("trust proxy", 1); // deploy кезінде керек болады (https/proxy)

app.disable("etag"); // 🔥 304 кессін
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.use(session({
  name: "gotab.sid",
  secret: process.env.SESSION_SECRET || "dev_secret_change_me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 күн
  }
}));

// DEBUG LOG
app.use((req,res,next)=>{
  console.log("REQ", req.method, req.url, "Origin=", req.headers.origin);
  res.on("finish", ()=> console.log("DONE", req.method, req.url, res.statusCode));
  next();
});

function requireAuth(req, res, next){
  if(req.session && req.session.user) return next();
  return res.status(401).json({ ok:false, error:"unauthorized" });
}

function requireAdmin(req, res, next){
  if(req.session?.user?.role === "admin") return next();
  return res.status(403).json({ ok:false, error:"forbidden" });
}

function requireStudent(req, res, next){
  if(req.session?.user?.role === "student") return next();
  return res.status(403).json({ ok:false, error:"forbidden" });
}

app.get("/api/auth/me", async (req, res) => {
  try {
    const u = req.session?.user || null;

    if (!u) {
      return res.json({ ok: true, user: null });
    }

    if (u.role === "admin") {
      return res.json({ ok: true, user: u });
    }

    const studentId = String(u.studentId || "").trim();
    if (!studentId) {
      return res.json({ ok: true, user: null });
    }

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/users?select=*&student_id=eq.${encodeURIComponent(studentId)}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const rows = await r.json().catch(() => []);

    if (!r.ok) {
      console.error("auth/me supabase error:", rows);
      return res.status(500).json({ ok: false, error: "supabase_error" });
    }

    const st = Array.isArray(rows) ? rows[0] : null;

    if (!st) {
      return res.json({ ok: true, user: null });
    }

    const freshUser = {
      role: "student",
      studentId: String(st.student_id || ""),
      package: String(st.package || "pending").toLowerCase(),
      grade: Number(st.grade || 5),
      fullName: st.full_name || "Оқушы",
      phone: st.phone || "",
      email: st.email || "",
      avatar: st.avatar || ""
    };

    req.session.user = freshUser;

    return res.json({ ok: true, user: freshUser });
  } catch (e) {
    console.error("auth/me error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/auth/logout", (req,res)=>{
  req.session.destroy(()=> {
    res.clearCookie("gotab.sid");
    return res.json({ ok:true });
  });
});

app.post("/api/auth/login", async (req,res)=>{
  const role = String(req.body?.role || "").toLowerCase().trim();



    // ===== ADMIN LOGIN =====
  if(role === "admin"){
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

   const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase();
   const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH || "";
   if(email !== ADMIN_EMAIL){
  return res.status(401).json({ ok:false, error:"bad_credentials" });
}

const ok = await bcrypt.compare(password, ADMIN_PASS_HASH);

if(!ok){
  return res.status(401).json({ ok:false, error:"bad_credentials" });
} 

    req.session.user = { role:"admin", email: ADMIN_EMAIL };
    return res.json({ ok:true, user: req.session.user });
  }

  // ===== STUDENT LOGIN (әзірше studentId) =====
 if (role === "student") {
  const phone = String(req.body?.phone || "").trim();
  const password = String(req.body?.password || "");

  if (!phone || !password) {
    return res.status(400).json({ ok: false, error: "missing_fields" });
  }

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/users?select=*&phone=eq.${encodeURIComponent(phone)}`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    }
  );

  const rows = await r.json().catch(() => []);
  if (!r.ok) {
    console.error("student login supabase error:", rows);
    return res.status(500).json({ ok: false, error: "supabase_error" });
  }

  const st = Array.isArray(rows) ? rows[0] : null;

  if (!st) {
    return res.status(401).json({ ok: false, error: "student_not_found" });
  }

  const ok = await bcrypt.compare(password, st.password_hash);

  if (!ok) {
    return res.status(401).json({ ok: false, error: "bad_credentials" });
  }

  req.session.user = {
    role: "student",
    studentId: String(st.student_id || "").trim(),
    package: String(st.package || "pending").toLowerCase(),
    grade: Number(st.grade || 5),
    fullName: st.full_name || "Оқушы",
    phone: st.phone || "",
    email: st.email || "",
    avatar: st.avatar || ""
  };

  return res.json({ ok: true, user: req.session.user });
}
return res.status(400).json({ ok:false, error:"bad_role" });
});

// Static folders for uploaded files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/student_uploads", express.static(path.join(__dirname, "student_uploads")));

// ===================== SIMPLE JSON DB =====================
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
console.log("CWD =", process.cwd());
console.log("DB_PATH =", DB_PATH);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function defaultDB() {
  return {
    users: [], // {studentId, fullName, phone, email, passwordHash, package, grade, avatar}

    materials: {
      "5": { math: {} },
      "6": { math: {} },
      "7": { algebra: {}, geometry: {} },
      "8": { algebra: {}, geometry: {} },
      "9": { algebra: {}, geometry: {} },
      "10": { algebra: {}, geometry: {} },
      "11": { algebra: {}, geometry: {} }
    },

    progress: {}, // progress[studentId][grade][subject][block] = {grade,status,feedbackText,feedbackFileUrl,updatedAt}
    notifications: {}, // notifications[studentId] = [{id,type,text,createdAt,read}]
    streak: {} // streak[studentId] = { lastVisitDate, current, best, totalLogins }
  };
}

function ensureDB() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDB(), null, 2), "utf-8");
  }
}

function readDB() {
  ensureDB();
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    const db = JSON.parse(raw || "{}");

   if (!db.users) db.users = [];

if (!db.materials) {
  db.materials = {
    "5": { math: {} },
    "6": { math: {} },
    "7": { algebra: {}, geometry: {} },
    "8": { algebra: {}, geometry: {} },
    "9": { algebra: {}, geometry: {} },
    "10": { algebra: {}, geometry: {} },
    "11": { algebra: {}, geometry: {} }
  };
}

for (const g of ["5","6","7","8","9","10","11"]) {
  if (!db.materials[g]) db.materials[g] = {};
}

if (!db.materials["5"].math) db.materials["5"].math = {};
if (!db.materials["6"].math) db.materials["6"].math = {};

for (const g of ["7","8","9","10","11"]) {
  if (!db.materials[g].algebra) db.materials[g].algebra = {};
  if (!db.materials[g].geometry) db.materials[g].geometry = {};
}

if (!db.progress) db.progress = {};
if (!db.notifications) db.notifications = {};
if (!db.streak) db.streak = {};
    // ✅ MIGRATION: old db.students -> db.users
if (Array.isArray(db.students) && db.students.length > 0) {
  const existing = new Set(db.users.map(u => String(u.studentId || "")));

  for (const st of db.students) {
    const sid = String(st.studentId || "");
    if (!sid) continue;

    if (!existing.has(sid)) {
      db.users.push(st);
      existing.add(sid);
    }
  }
}

    return db;
  } catch (e) {
    console.error("DB parse error:", e);
    return defaultDB();
  }
}

function writeDB(db) {
  ensureDB();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function nowISO(){
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Almaty" });
}

function todayYMD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ===================== COURSES =====================
function normalizeCourse(course) {
  const c = String(course || "").toLowerCase().trim();
  if (c === "baza" || c === "base") return "base";
  if (c === "standart" || c === "standard") return "standart";
  if (c === "premium") return "premium";
  return ""; // invalid
}

function safeCourse(course) {
  const c = normalizeCourse(course);
  return c === "base" || c === "standart" || c === "premium";
}

function normalizeGrade(grade) {
  const g = Number(grade);
  return [5,6,7,8,9,10,11].includes(g) ? String(g) : "";
}

function normalizeSubject(grade, subject) {
  const g = Number(grade);
  const s = String(subject || "").toLowerCase().trim();

  if ([5,6].includes(g) && s === "math") return "math";
  if ([7,8,9,10,11].includes(g) && (s === "algebra" || s === "geometry")) return s;

  return "";
}

function getAllowedGradesByPackage(pkg, grade) {
  const p = String(pkg || "").toLowerCase().trim();
  const g = Number(grade);

  if (p === "base") {
    if (g === 5) return [5];
    if (g === 6) return [5, 6];
    if (g === 7) return [5, 6, 7];
    return [];
  }

  if (p === "standart") {
    if (g === 8) return [5, 6, 7, 8];
    if (g === 9) return [5, 6, 7, 8, 9];
    return [];
  }

  if (p === "premium") {
    if (g === 10) return [5, 6, 7, 8, 9, 10];
    if (g === 11) return [5, 6, 7, 8, 9, 10, 11];
    return [];
  }

  return [];
}

function isValidPackageGrade(pkg, grade) {
  return getAllowedGradesByPackage(pkg, grade).length > 0;
}

function getBlockCount(grade, subject) {
  const g = Number(grade);
  const s = String(subject || "").toLowerCase().trim();

  if (g === 5 || g === 6) {
    return s === "math" ? 50 : 0;
  }

  if (g === 7 || g === 8) {
    if (s === "algebra" || s === "geometry") return 25;
    return 0;
  }

  if ([9, 10, 11].includes(g)) {
    if (s === "algebra" || s === "geometry") return 30;
    return 0;
  }

  return 0;
}

function safeBlockNumber(n, grade, subject) {
  const x = Number(n);
  const max = getBlockCount(grade, subject);
  return Number.isFinite(x) && x >= 1 && x <= max;
}

// ===================== AUTH (demo) =====================
function makeStudentId(phone, email) {
  const raw = (String(phone || "") + "|" + String(email || "")).toLowerCase();
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return "st_" + h.toString(16);
}

async function pushNotif(studentId, type, text) {
  try {
    const row = {
      id: "n_" + Date.now() + "_" + Math.random().toString(16).slice(2),
      student_id: String(studentId || ""),
      type: String(type || ""),
      text: String(text || ""),
      read: false
    };

    const r = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify([row])
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      console.error("pushNotif supabase error:", data);
    }
  } catch (e) {
    console.error("pushNotif error:", e);
  }
}

// Register
app.post("/api/auth/register", async (req, res) => {
  try {
    const { firstName, lastName, phone, email, password, password2 } = req.body || {};

    if (!firstName || !lastName || !phone || !email || !password) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    if (password !== password2) {
      return res.status(400).json({ ok: false, error: "password_mismatch" });
    }

    if (String(password).length < 4) {
      return res.status(400).json({ ok: false, error: "weak_password" });
    }

    const phoneClean = String(phone).trim();
    const emailClean = String(email).trim().toLowerCase();

    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?select=student_id,phone&phone=eq.${encodeURIComponent(phoneClean)}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const existing = await checkRes.json().catch(() => []);

    if (Array.isArray(existing) && existing.length > 0) {
      return res.status(409).json({ ok: false, error: "phone_exists" });
    }

    const studentId = makeStudentId(phoneClean, emailClean);
    const passwordHash = await bcrypt.hash(String(password), 10);

    const user = {
      student_id: studentId,
      full_name: `${String(firstName).trim()} ${String(lastName).trim()}`.trim(),
      first_name: String(firstName).trim(),
      last_name: String(lastName).trim(),
      phone: phoneClean,
      email: emailClean,
      password_hash: passwordHash,
      grade: 5,
      package: "pending",
      avatar: ""
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify([user])
    });

    const inserted = await insertRes.json().catch(() => null);

    if (!insertRes.ok) {
      console.error("users insert error:", inserted);
      return res.status(500).json({
        ok: false,
        error: "supabase_insert_failed",
        data: inserted
      });
    }

    req.session.user = {
      role: "student",
      studentId: studentId,
      package: "pending",
      grade: 5,
      fullName: user.full_name,
      phone: user.phone,
      email: user.email,
      avatar: user.avatar || ""
    };
    await pushNotif(studentId, "welcome", `Қош келдің, ${user.full_name}! Аккаунтың ашылды ✅`);
    await pushNotif(studentId, "package", `Пакетіңіз әлі бекітілмеді. Төлем тексерілген соң курс ашылады ⏳`);

    return res.json({
      ok: true,
      user: req.session.user
    });
  } catch (e) {
    console.error("register error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
// ===================== ADMIN: STUDENTS LIST =====================
app.get("/api/admin/students", requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/users?select=*`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    });

    const rows = await r.json().catch(() => []);

    if (!r.ok) {
      console.error("admin/students supabase error:", rows);
      return res.status(500).json({ ok: false, error: "supabase_error" });
    }

    const students = (Array.isArray(rows) ? rows : []).map((u) => ({
      studentId: u.student_id,
      fullName: u.full_name,
      phone: u.phone,
      email: u.email,
      package: u.package || "pending",
      grade: Number(u.grade || 5),
      avatar: u.avatar || "",
      createdAt: u.created_at || ""
    }));

    res.json({ ok: true, students });
  } catch (e) {
    console.error("admin/students error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/set-package", requireAdmin, async (req, res) => {
  try {
    const studentId = String(req.body?.studentId || "").trim();
    let pkg = String(req.body?.package || "").trim().toLowerCase();

    if (pkg === "baza") pkg = "base";
    if (pkg === "standard") pkg = "standart";

    if (!["pending", "base", "standart", "premium"].includes(pkg)) {
      return res.status(400).json({ ok: false, error: "bad_package" });
    }

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/users?student_id=eq.${encodeURIComponent(studentId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({ package: pkg })
      }
    );

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      console.error("set-package supabase error:", data);
      return res.status(500).json({ ok: false, error: "supabase_update_failed", data });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("set-package error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/set-student-meta", requireAdmin, async (req, res) => {
  try {
    const studentId = String(req.body?.studentId || "").trim();
    let pkg = String(req.body?.package || "").trim().toLowerCase();
    const grade = Number(req.body?.grade);

    if (pkg === "baza") pkg = "base";
    if (pkg === "standard") pkg = "standart";

    if (!["pending", "base", "standart", "premium"].includes(pkg)) {
      return res.status(400).json({ ok: false, error: "bad_package" });
    }

    if (![5,6,7,8,9,10,11].includes(grade)) {
      return res.status(400).json({ ok: false, error: "bad_grade" });
    }

    if (pkg !== "pending" && !isValidPackageGrade(pkg, grade)) {
      return res.status(400).json({
        ok: false,
        error: "bad_package_grade_combo"
      });
    }

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/users?student_id=eq.${encodeURIComponent(studentId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          package: pkg,
          grade: grade
        })
      }
    );

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      console.error("set-student-meta supabase error:", data);
      return res.status(500).json({ ok: false, error: "supabase_update_failed", data });
    }

    return res.json({
      ok: true,
      allowedGrades: getAllowedGradesByPackage(pkg, grade)
    });
  } catch (e) {
    console.error("set-student-meta error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/admin/student/:studentId", requireAdmin, async (req, res) => {
  try {
    const sid = String(req.params.studentId || "");

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/users?select=*&student_id=eq.${encodeURIComponent(sid)}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const rows = await r.json().catch(() => []);
    if (!r.ok) {
      console.error("admin/student supabase error:", rows);
      return res.status(500).json({ ok: false, error: "supabase_error" });
    }

    const u = Array.isArray(rows) ? rows[0] : null;

    if (!u) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const pkg = String(u.package || "pending").toLowerCase();
    const grade = Number(u.grade || 5);

    res.json({
      ok: true,
      student: {
        studentId: u.student_id,
        fullName: u.full_name,
        phone: u.phone,
        email: u.email,
        package: pkg,
        grade,
        allowedGrades: getAllowedGradesByPackage(pkg, grade)
      }
    });
  } catch (e) {
    console.error("admin/student error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ===================== MULTER STORAGE =====================
// ADMIN uploads
const adminStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const grade = normalizeGrade(req.body.grade);
    const subject = normalizeSubject(grade, req.body.subject);
    const block = Number(req.body.blockNumber);

if (!grade || !subject || !safeBlockNumber(block, grade, subject)) {
  return cb(new Error("Bad grade/subject/block"));
}

    const dest = path.join(__dirname, "uploads", grade, subject, "block" + block);
    ensureDir(dest);
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const safeName = String(file.originalname || "file").replace(/\s+/g, "_");
    cb(null, Date.now() + "-" + safeName);
  },
});
const uploadAdmin = multer({ storage: adminStorage });

// STUDENT uploads
const studentStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const grade = normalizeGrade(req.body.grade);
    const subject = normalizeSubject(grade, req.body.subject);
    const block = Number(req.body.blockNumber);
    const studentId = String(req.session?.user?.studentId || "");

   if (!grade || !subject || !safeBlockNumber(block, grade, subject) || !studentId) {
  return cb(new Error("Bad input"));
}

    const dest = path.join(__dirname, "student_uploads", grade, subject, "block" + block, studentId);
    ensureDir(dest);
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const safeName = String(file.originalname || "file").replace(/\s+/g, "_");
    cb(null, Date.now() + "-" + safeName);
  },
});
const uploadStudent = multer({ storage: studentStorage });

// ===================== MATERIALS =====================
// Admin upload 1 file
app.post("/api/admin/upload", requireAdmin, uploadAdmin.single("file"), async (req, res) => {
  try {
    const grade = normalizeGrade(req.body.grade);
    const subject = normalizeSubject(grade, req.body.subject);
    const block = Number(req.body.blockNumber);
    const type = String(req.body.type || "").toLowerCase(); // video|audio|doc

    if (!grade || !subject || !safeBlockNumber(block, grade, subject) || !req.file) {
      return res.status(400).json({ ok: false, error: "bad_grade_subject_or_block" });
    }

   const ext = path.extname(req.file.originalname || "") || ".bin";
   const filePath = `materials/${grade}/${subject}/block${block}/${Date.now()}${ext}`; 

    const buffer = fs.readFileSync(req.file.path);

    const publicUrl = await uploadBufferToSupabaseStorage(
      "files",
      filePath,
      buffer,
      req.file.mimetype
    );

    try { fs.unlinkSync(req.file.path); } catch {}

    const dbType =
      type === "video" ? "video" :
      type === "audio" ? "audio" : "doc";

    const r = await fetch(`${SUPABASE_URL}/rest/v1/materials`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify([{
        grade,
        subject,
        block,
        type: dbType,
        url: publicUrl
      }])
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      console.error("supabase insert materials error:", data);
      return res.status(500).json({ ok: false, error: "supabase_insert_failed", data });
    }

    const item = {
      url: publicUrl,
      name: req.file.originalname,
      createdAt: nowISO()
    };

    return res.json({
      ok: true,
      grade,
      subject,
      block: String(block),
      item
    });
  } catch (e) {
   console.error("admin upload error:", e);
return res.status(500).json({ ok: false, error: "server_error", message: String(e.message || e) });
  }
});

// Student upload homework
app.post("/api/student/upload", requireStudent, uploadStudent.single("file"), async (req, res) => {
  try {
    const grade = normalizeGrade(req.body.grade);
    const subject = normalizeSubject(grade, req.body.subject);
    const block = Number(req.body.blockNumber);
    const studentId = String(req.session?.user?.studentId || "");

    if (!grade || !subject || !safeBlockNumber(block, grade, subject) || !studentId || !req.file) {
      return res.status(400).json({ ok: false, error: "bad_input" });
    }

    const ext = path.extname(req.file.originalname || "") || ".bin";
    const filePath = `student_uploads/${studentId}/${grade}/${subject}/block${block}/${Date.now()}${ext}`;

    const buffer = fs.readFileSync(req.file.path);

    const publicUrl = await uploadBufferToSupabaseStorage(
      "files",
      filePath,
      buffer,
      req.file.mimetype
    );

    try { fs.unlinkSync(req.file.path); } catch {}

   const supaItem = {
  student_id: studentId,
  grade,
  subject,
  block,
  url: publicUrl,
  name: req.file.originalname,
  status: "uploaded"
};

    const sr = await fetch(`${SUPABASE_URL}/rest/v1/student_uploads`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify([supaItem])
    });

    const supaData = await sr.json().catch(() => null);

    if (!sr.ok) {
      console.error("student_uploads insert error:", supaData);
      return res.status(500).json({ ok: false, error: "supabase_insert_failed", data: supaData });
    }

    let course = String(req.session?.user?.package || "").toLowerCase().trim();
if (course === "baza") course = "base";
if (course === "standard") course = "standart";

if (!["base", "standart", "premium"].includes(course)) {
  course = "base";
}

const checkProgRes = await fetch(
  `${SUPABASE_URL}/rest/v1/progress?select=*&student_id=eq.${encodeURIComponent(studentId)}&course=eq.${encodeURIComponent(course)}&grade=eq.${encodeURIComponent(grade)}&subject=eq.${encodeURIComponent(subject)}&block=eq.${block}`,
  {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    }
  }
);

const existingProgRows = await checkProgRes.json().catch(() => []);
if (!checkProgRes.ok) {
  console.error("student upload progress check error:", existingProgRows);
  return res.status(500).json({ ok: false, error: "supabase_progress_check_failed" });
}

const prevProg = Array.isArray(existingProgRows) ? existingProgRows[0] : null;

const progressRow = {
  student_id: studentId,
  course,
  grade,
  subject,
  block,
  grade_value: prevProg?.grade_value ?? null,
  status: "uploaded",
  feedback_text: prevProg?.feedback_text || "",
  feedback_file_url: prevProg?.feedback_file_url || "",
  updated_at: new Date().toISOString()
};

let progSaveRes;
let progSaveData;

if (prevProg) {
  progSaveRes = await fetch(
    `${SUPABASE_URL}/rest/v1/progress?student_id=eq.${encodeURIComponent(studentId)}&course=eq.${encodeURIComponent(course)}&grade=eq.${encodeURIComponent(grade)}&subject=eq.${encodeURIComponent(subject)}&block=eq.${block}`,
    {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(progressRow)
    }
  );
  progSaveData = await progSaveRes.json().catch(() => null);
} else {
  progSaveRes = await fetch(`${SUPABASE_URL}/rest/v1/progress`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify([progressRow])
  });
  progSaveData = await progSaveRes.json().catch(() => null);
}

if (!progSaveRes.ok) {
  console.error("student upload progress save error:", progSaveData);
  return res.status(500).json({ ok: false, error: "supabase_progress_save_failed", data: progSaveData });
}

const db = readDB();
await pushNotif(studentId, "upload", `(${grade} сынып, ${subject}) Блок ${block}: тапсырма жүктелді ✅`);
writeDB(db);

    return res.json({
      ok: true,
      grade,
      subject,
      block: String(block),
      item: {
        url: publicUrl,
        name: req.file.originalname,
        studentId,
        createdAt: nowISO(),
        status: "uploaded"
      }
    });
  } catch (e) {
    console.error("student upload error:", e);
    return res.status(500).json({ ok: false, error: "server_error", message: String(e.message || e) });
  }
});

// Avatar upload
app.post("/api/avatar/upload", requireStudent, uploadAvatar.single("avatar"), async (req, res) => {
  try {
    const studentId = String(req.session?.user?.studentId || "");

    if (!studentId || !req.file) {
      return res.status(400).json({ ok:false, error:"bad_input" });
    }

    const avatarUrl = "/uploads/avatars/" + req.file.filename;

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/users?student_id=eq.${encodeURIComponent(studentId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          avatar: avatarUrl
        })
      }
    );

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      console.error("avatar update supabase error:", data);
      return res.status(500).json({ ok:false, error:"supabase_update_failed", data });
    }

    if (req.session?.user) {
      req.session.user.avatar = avatarUrl;
    }

    return res.json({
      ok:true,
      url: avatarUrl
    });
  } catch (e) {
    console.error("avatar upload error:", e);
    return res.status(500).json({
      ok:false,
      error:"server_error",
      message:String(e.message || e)
    });
  }
});

// Get block materials
app.get("/api/materials", async (req, res) => {
  try {
    const { grade, subject, blockNumber } = req.query;

    const r1 = await fetch(
      `${SUPABASE_URL}/rest/v1/materials?select=*&grade=eq.${grade}&subject=eq.${subject}&block=eq.${blockNumber}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const materialsData = await r1.json().catch(() => []);

    const r2 = await fetch(
      `${SUPABASE_URL}/rest/v1/student_uploads?select=*&grade=eq.${grade}&subject=eq.${subject}&block=eq.${blockNumber}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const uploadsData = await r2.json().catch(() => []);

    const videos = materialsData.filter(x => x.type === "video");
    const docs = materialsData.filter(x => x.type === "doc");
    const audios = materialsData.filter(x => x.type === "audio");

    const studentUploads = uploadsData.map(x => ({
      url: x.url,
      name: x.name,
      studentId: x.student_id,
      createdAt: x.created_at,
      status: x.status || "uploaded"
    }));

    res.json({
      videos,
      docs,
      audios,
      studentUploads
    });
  } catch (e) {
    console.error("materials error:", e);
    res.json({
      videos: [],
      docs: [],
      audios: [],
      studentUploads: []
    });
  }
});

// ===================== PROGRESS PIPELINE =====================
// ✅ Get progress (per student, per course) + gradesMap + feedbackMap
app.get("/api/progress/get", requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session?.user || null;
    const requestedStudentId = String(req.query.studentId || "");
    const grade = normalizeGrade(req.query.grade);
    const subject = normalizeSubject(grade, req.query.subject);

    let course = String(req.query.course || req.query.package || "").toLowerCase().trim();
    if (course === "baza") course = "base";
    if (course === "standard") course = "standart";

    const studentId =
      sessionUser?.role === "admin"
        ? requestedStudentId
        : String(sessionUser?.studentId || "");

    if (!studentId || !grade || !subject) {
      return res.status(400).json({ ok: false, error: "bad_input" });
    }

    if (!["base", "standart", "premium"].includes(course)) {
      course =
        String(sessionUser?.package || "").toLowerCase() === "baza"
          ? "base"
          : String(sessionUser?.package || "").toLowerCase() === "standard"
            ? "standart"
            : String(sessionUser?.package || "").toLowerCase();
    }

    if (!["base", "standart", "premium"].includes(course)) {
      return res.status(400).json({ ok: false, error: "bad_course" });
    }

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/progress?select=*&student_id=eq.${encodeURIComponent(studentId)}&course=eq.${encodeURIComponent(course)}&grade=eq.${encodeURIComponent(grade)}&subject=eq.${encodeURIComponent(subject)}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const rows = await r.json().catch(() => []);
    if (!r.ok) {
      console.error("progress/get supabase error:", rows);
      return res.status(500).json({ ok: false, error: "supabase_error" });
    }

    const subjProg = {};
    const gradesMap = {};
    const feedbackMap = {};

    (Array.isArray(rows) ? rows : []).forEach((item) => {
      const block = String(item.block);
      subjProg[block] = {
        grade: item.grade_value,
        status: item.status || "none",
        feedbackText: item.feedback_text || "",
        feedbackFileUrl: item.feedback_file_url || "",
        updatedAt: item.updated_at || ""
      };

      const g = Number(item.grade_value);
      if (Number.isFinite(g) && g > 0) gradesMap[block] = g;

      const fb = String(item.feedback_text || "");
      if (fb.trim()) {
        feedbackMap[block] = { text: fb, updatedAt: item.updated_at || "" };
      }
    });

    return res.json({
      ok: true,
      course,
      grade,
      subject,
      data: subjProg,
      gradesMap,
      feedbackMap,
    });
  } catch (e) {
    console.error("progress/get error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/progress/summary", requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session?.user || null;
    const requestedStudentId = String(req.query.studentId || "");

    let course = String(req.query.course || req.query.package || "").toLowerCase().trim();
    if (course === "baza") course = "base";
    if (course === "standard") course = "standart";

    const studentId =
      sessionUser?.role === "admin"
        ? requestedStudentId
        : String(sessionUser?.studentId || "");

    if (!studentId) {
      return res.status(400).json({ ok: false, error: "bad_input" });
    }

    if (!["base", "standart", "premium"].includes(course)) {
      course =
        String(sessionUser?.package || "").toLowerCase() === "baza"
          ? "base"
          : String(sessionUser?.package || "").toLowerCase() === "standard"
            ? "standart"
            : String(sessionUser?.package || "").toLowerCase();
    }

    if (!["base", "standart", "premium"].includes(course)) {
      return res.status(400).json({ ok: false, error: "bad_course" });
    }

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/progress?select=*&student_id=eq.${encodeURIComponent(studentId)}&course=eq.${encodeURIComponent(course)}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const rows = await r.json().catch(() => []);
    if (!r.ok) {
      console.error("progress/summary supabase error:", rows);
      return res.status(500).json({ ok: false, error: "supabase_error" });
    }

    const flat = {};

    (Array.isArray(rows) ? rows : []).forEach((item) => {
      const key = `${item.grade}_${item.subject}_${item.block}`;
      flat[key] = {
        grade: Number(item.grade_value ?? 0),
        status: String(item.status || ""),
        feedbackText: String(item.feedback_text || ""),
        feedbackFileUrl: String(item.feedback_file_url || ""),
        updatedAt: item.updated_at || "",
        schoolGrade: Number(item.grade),
        subject: item.subject,
        blockNumber: Number(item.block),
        course: item.course
      };
    });

    return res.json({ ok: true, course, data: flat });
  } catch (e) {
    console.error("progress/summary error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ✅ Admin sets grade/status/feedback (lessonNumber OR lesson) + auto graded status

app.post("/api/progress/set", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};

    const studentId = String(body.studentId || "");
    const grade = normalizeGrade(body.grade);
    const subject = normalizeSubject(grade, body.subject);
    const block = Number(body.blockNumber);

    let course = String(body.course || body.package || "").toLowerCase().trim();
    if (course === "baza") course = "base";
    if (course === "standard") course = "standart";

    const gradeRaw = body.gradeValue;
    const statusRaw = body.status;
    const feedbackText = body.feedbackText;
    const feedbackFileUrl = body.feedbackFileUrl;

    if (!studentId || !grade || !subject || !safeBlockNumber(block, grade, subject)) {
      return res.status(400).json({ ok: false, error: "bad_input" });
    }

    if (!["base", "standart", "premium"].includes(course)) {
      return res.status(400).json({ ok: false, error: "bad_course" });
    }

    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/progress?select=*&student_id=eq.${encodeURIComponent(studentId)}&course=eq.${encodeURIComponent(course)}&grade=eq.${encodeURIComponent(grade)}&subject=eq.${encodeURIComponent(subject)}&block=eq.${block}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const existingRows = await checkRes.json().catch(() => []);
    if (!checkRes.ok) {
      console.error("progress/set check error:", existingRows);
      return res.status(500).json({ ok: false, error: "supabase_error" });
    }

    const prev = Array.isArray(existingRows) && existingRows[0] ? existingRows[0] : null;

    let nextGradeValue = prev?.grade_value ?? null;
    let nextStatus = prev?.status || "none";
    let nextFeedbackText = prev?.feedback_text || "";
    let nextFeedbackFileUrl = prev?.feedback_file_url || "";

    let gradeSet = false;
    if (gradeRaw !== undefined && gradeRaw !== null && gradeRaw !== "") {
      const g = Number(gradeRaw);
      if (!Number.isFinite(g) || g < 0 || g > 100) {
        return res.status(400).json({ ok: false, error: "bad_grade" });
      }
      nextGradeValue = g;
      gradeSet = true;
    }

    if (statusRaw !== undefined && statusRaw !== null && statusRaw !== "") {
      nextStatus = String(statusRaw).toLowerCase();
    }

    if (gradeSet) nextStatus = "graded";
    if (feedbackText !== undefined) nextFeedbackText = String(feedbackText || "");
    if (feedbackFileUrl !== undefined) nextFeedbackFileUrl = String(feedbackFileUrl || "");

    const row = {
      student_id: studentId,
      course,
      grade,
      subject,
      block,
      grade_value: nextGradeValue,
      status: nextStatus,
      feedback_text: nextFeedbackText,
      feedback_file_url: nextFeedbackFileUrl,
      updated_at: new Date().toISOString()
    };

    let saveRes;
    let saveData;

    if (prev) {
      saveRes = await fetch(
        `${SUPABASE_URL}/rest/v1/progress?student_id=eq.${encodeURIComponent(studentId)}&course=eq.${encodeURIComponent(course)}&grade=eq.${encodeURIComponent(grade)}&subject=eq.${encodeURIComponent(subject)}&block=eq.${block}`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify(row)
        }
      );
      saveData = await saveRes.json().catch(() => null);
    } else {
      saveRes = await fetch(`${SUPABASE_URL}/rest/v1/progress`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify([row])
      });
      saveData = await saveRes.json().catch(() => null);
    }

    if (!saveRes.ok) {
      console.error("progress/set save error:", saveData);
      return res.status(500).json({ ok: false, error: "supabase_save_failed", data: saveData });
    }

    const db = readDB();

    const oldGrade = Number(prev?.grade_value ?? 0);
    const newGrade = Number(nextGradeValue ?? 0);

    const oldFeedback = String(prev?.feedback_text || "").trim();
    const newFeedback = String(nextFeedbackText || "").trim();

    if (newFeedback && newFeedback !== oldFeedback) {
  await pushNotif(
    studentId,
    "feedback",
    `[${course}] (${grade} сынып, ${subject}) Блок ${block}: мұғалім пікір қалдырды 💬`
  );
}

if (Number.isFinite(newGrade) && newGrade > 0 && newGrade !== oldGrade) {
  await pushNotif(
    studentId,
    "review",
    `[${course}] (${grade} сынып, ${subject}) Блок ${block}: баға қойылды 🏅`
  );
}

    writeDB(db);
    return res.json({ ok: true });
  } catch (e) {
    console.error("progress/set error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
// ================= STREAK (SERVER) =================
// days = ["YYYY-MM-DD", ...]
function calcStreakFromDays(days, todayStr){
  const set = new Set(Array.isArray(days) ? days : []);
  let streak = 0;

  // todayStr-ті негізге аламыз (клиент жіберген)
  // Кері қарай 1 күннен азайтып отырамыз
  let cur = new Date(todayStr + "T00:00:00");
  for(;;){
    const y = cur.getFullYear();
    const m = String(cur.getMonth()+1).padStart(2,"0");
    const d = String(cur.getDate()).padStart(2,"0");
    const key = `${y}-${m}-${d}`;
    if(set.has(key)){
      streak++;
      cur.setDate(cur.getDate() - 1);
    }else{
      break;
    }
  }
  return streak;
}

// POST /api/streak/ping  { studentId, dayKey: "YYYY-MM-DD" }
app.post("/api/streak/ping", async (req,res)=>{
  try{
    const studentId = String(req.body?.studentId || "").trim();
    const dayKey = String(req.body?.dayKey || "").trim();

    if(!studentId || !dayKey){
      return res.status(400).json({ ok:false, error:"bad_input" });
    }

    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/streak?select=student_id,days,updated_at&student_id=eq.${encodeURIComponent(studentId)}`,
      {
        headers:{
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const checkRows = await checkRes.json().catch(() => []);
    if(!checkRes.ok){
      console.error("streak/ping check error:", checkRows);
      return res.status(500).json({ ok:false, error:"supabase_error" });
    }

    const existing = Array.isArray(checkRows) ? checkRows[0] : null;

    let days = Array.isArray(existing?.days) ? existing.days : [];

    if(!days.includes(dayKey)){
      days.push(dayKey);
    }

    days.sort();
    days = days.slice(-180);

    let saveRes;
    let saveData;

    if(existing){
      saveRes = await fetch(
        `${SUPABASE_URL}/rest/v1/streak?student_id=eq.${encodeURIComponent(studentId)}`,
        {
          method:"PATCH",
          headers:{
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type":"application/json",
            Prefer:"return=representation"
          },
          body: JSON.stringify({
            days,
            updated_at: new Date().toISOString()
          })
        }
      );
      saveData = await saveRes.json().catch(() => null);
    } else {
      saveRes = await fetch(`${SUPABASE_URL}/rest/v1/streak`, {
        method:"POST",
        headers:{
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type":"application/json",
          Prefer:"return=representation"
        },
        body: JSON.stringify([{
          student_id: studentId,
          days,
          updated_at: new Date().toISOString()
        }])
      });
      saveData = await saveRes.json().catch(() => null);
    }

    if(!saveRes.ok){
      console.error("streak/ping save error:", saveData);
      return res.status(500).json({ ok:false, error:"supabase_save_failed", data: saveData });
    }

    const streak = calcStreakFromDays(days, dayKey);

    return res.json({ ok:true, studentId, dayKey, streak, days });
  }catch(e){
    console.error("streak/ping error", e);
    return res.status(500).json({ ok:false, error:"server_error" });
  }
});

// GET /api/streak/get?studentId=...&dayKey=YYYY-MM-DD
app.get("/api/streak/get", async (req,res)=>{
  try{
    const studentId = String(req.query?.studentId || "").trim();
    const dayKey = String(req.query?.dayKey || "").trim();

    if(!studentId || !dayKey){
      return res.status(400).json({ ok:false, error:"bad_input" });
    }

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/streak?select=student_id,days,updated_at&student_id=eq.${encodeURIComponent(studentId)}`,
      {
        headers:{
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const rows = await r.json().catch(() => []);
    if(!r.ok){
      console.error("streak/get error:", rows);
      return res.status(500).json({ ok:false, error:"supabase_error" });
    }

    const rec = Array.isArray(rows) ? rows[0] : null;
    const days = Array.isArray(rec?.days) ? rec.days : [];
    const streak = calcStreakFromDays(days, dayKey);

    return res.json({ ok:true, studentId, dayKey, streak, days });
  }catch(e){
    console.error("streak/get error", e);
    return res.status(500).json({ ok:false, error:"server_error" });
  }
});

// ===================== NOTIFICATIONS =====================
app.get("/api/notifications", requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session?.user || null;
    if (!sessionUser) return res.status(401).json({ ok: false, error: "unauthorized" });

    const requestedStudentId = String(req.query.studentId || "");
    const sessionStudentId = String(sessionUser.studentId || "");

    const studentId =
      sessionUser.role === "admin"
        ? requestedStudentId
        : sessionStudentId;

    if (!studentId) {
      return res.status(400).json({ ok: false, error: "missing_studentId" });
    }

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/notifications?select=*&student_id=eq.${encodeURIComponent(studentId)}&order=created_at.desc&limit=30`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const rows = await r.json().catch(() => []);
    if (!r.ok) {
      console.error("notifications get supabase error:", rows);
      return res.status(500).json({ ok: false, error: "supabase_error" });
    }

    const list = (Array.isArray(rows) ? rows : []).map((n) => ({
      id: n.id,
      type: n.type,
      text: n.text,
      createdAt: n.created_at,
      read: !!n.read
    }));

    return res.json({ ok: true, list });
  } catch (e) {
    console.error("notifications get error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/notifications/mark-read", requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session?.user || null;
    const { studentId: requestedStudentId, id } = req.body || {};

    if (!id) return res.status(400).json({ ok: false, error: "bad_input" });

    const studentId =
      sessionUser?.role === "admin"
        ? String(requestedStudentId || "")
        : String(sessionUser?.studentId || "");

    if (!studentId) {
      return res.status(400).json({ ok: false, error: "bad_input" });
    }

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/notifications?id=eq.${encodeURIComponent(id)}&student_id=eq.${encodeURIComponent(studentId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({ read: true })
      }
    );

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      console.error("notifications mark-read supabase error:", data);
      return res.status(500).json({ ok: false, error: "supabase_error" });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("notifications mark-read error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ===================== HEALTH =====================
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: nowISO() });
});

app.post("/api/admin/add-video-link", requireAdmin, async (req, res) => {
  try {
    const grade = String(req.body.grade || "").trim();
    const subject = String(req.body.subject || "").trim();
    const blockNumber = Number(req.body.blockNumber);
    const url = String(req.body.url || "").trim();

    if (!grade || !subject || !blockNumber || !url) {
      return res.status(400).json({ ok: false, error: "bad_input" });
    }

    const r = await fetch(`${SUPABASE_URL}/rest/v1/materials`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify([
        {
          grade,
          subject,
          block: blockNumber,
          type: "video",
          url
        }
      ])
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      console.error("supabase insert error:", data);
      return res.status(500).json({ ok: false, error: "supabase_insert_failed", data });
    }

    return res.json({ ok: true, data });
  } catch (e) {
    console.error("add-video-link error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ===================== START =====================
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
  console.log("👉 Index     : http://localhost:" + PORT + "/index.html");
  console.log("👉 Register  : http://localhost:" + PORT + "/register.html");
  console.log("👉 Admin     : http://localhost:" + PORT + "/admin.html");
  console.log("👉 Base      : http://localhost:" + PORT + "/base-blocks.html");
  console.log("👉 Standard  : http://localhost:" + PORT + "/standard-blocks.html");
  console.log("👉 Premium   : http://localhost:" + PORT + "/premium-blocks.html");
  console.log("👉 Dashboard : http://localhost:" + PORT + "/dashboard.html");
  console.log("👉 Health    : http://localhost:" + PORT + "/api/health");
});
