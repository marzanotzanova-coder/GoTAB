process.env.TZ = "Asia/Almaty";
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const compression = require("compression");
const OpenAI = require("openai");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// Prefers service role key (bypasses RLS). Falls back to anon key.
function sbKey() { return process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY; }
  
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

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

app.set("trust proxy", 1);
app.disable("etag");
app.disable("x-powered-by");

// ===================== SECURITY HEADERS =====================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https://*.supabase.co", "https://*.ytimg.com", "https://*.ggpht.com"],
      mediaSrc: ["'self'", "blob:", "https://*.supabase.co"],
      connectSrc: ["'self'", "https://*.supabase.co", "https://api.openai.com"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameSrc: ["'self'", "https://www.youtube.com", "https://youtube.com", "https://*.youtube.com", "https://player.vimeo.com", "https://*.supabase.co", "https://docs.google.com"],
      formAction: ["'self'"],
      upgradeInsecureRequests: IS_PROD ? [] : null,
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));

app.use(compression());

// ===================== CORS =====================
const ALLOWED_ORIGINS = IS_PROD
  ? ["https://gotab.onrender.com"]
  : ["http://localhost:3000", "http://localhost:3001", "http://127.0.0.1:3000"];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.use(express.json({ limit: "5mb" }));

// ===================== RATE LIMITERS =====================
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "too_many_requests" }
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "too_many_requests" }
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "too_many_requests" }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "too_many_requests" }
});

app.use("/api/", apiLimiter);
app.use("/api/auth/login", loginLimiter);

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
    secure: IS_PROD,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/mini", (req, res) => res.sendFile(path.join(__dirname, "mini.html")));

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
        apikey: sbKey(),
        Authorization: `Bearer ${sbKey()}`,
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
app.post("/api/auth/register", registerLimiter, async (req, res) => {
  try {
    const { firstName, lastName, phone, email, password, password2 } = req.body || {};

    if (!firstName || !lastName || !phone || !email || !password) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    if (password !== password2) {
      return res.status(400).json({ ok: false, error: "password_mismatch" });
    }

    if (String(password).length < 6) {
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
      return res.status(500).json({ ok: false, error: "server_error" });
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
      return res.status(500).json({ ok: false, error: "server_error" });
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
      return res.status(500).json({ ok: false, error: "server_error" });
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
    const safeName = path.basename(String(file.originalname || "file")).replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "-" + safeName);
  },
});
const uploadAdmin = multer({ storage: adminStorage, limits: { fileSize: 500 * 1024 * 1024 } });

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
    const safeName = path.basename(String(file.originalname || "file")).replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "-" + safeName);
  },
});
const uploadStudent = multer({ storage: studentStorage, limits: { fileSize: 100 * 1024 * 1024 } });

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
      return res.status(500).json({ ok: false, error: "server_error" });
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
return res.status(500).json({ ok: false, error: "server_error" });
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
        apikey: sbKey(),
        Authorization: `Bearer ${sbKey()}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify([supaItem])
    });

    const supaData = await sr.json().catch(() => null);

    if (!sr.ok) {
      console.error("student_uploads insert error:", supaData);
      return res.status(500).json({ ok: false, error: "server_error" });
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
      apikey: sbKey(),
      Authorization: `Bearer ${sbKey()}`
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
        apikey: sbKey(),
        Authorization: `Bearer ${sbKey()}`,
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
      apikey: sbKey(),
      Authorization: `Bearer ${sbKey()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify([progressRow])
  });
  progSaveData = await progSaveRes.json().catch(() => null);
}

if (!progSaveRes.ok) {
  console.error("student upload progress save error:", progSaveData);
  return res.status(500).json({ ok: false, error: "server_error" });
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
    return res.status(500).json({ ok: false, error: "server_error" });
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
    return res.status(500).json({ ok:false, error:"server_error" });
  }
});

// Get block materials
app.get("/api/materials", requireAuth, async (req, res) => {
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
      return res.status(500).json({ ok: false, error: "server_error" });
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
      `${SUPABASE_URL}/rest/v1/notifications?select=*&student_id=eq.${encodeURIComponent(studentId)}&type=not.in.(chat_out,chat_in,daily_watch)&order=created_at.desc&limit=30`,
      {
        headers: {
          apikey: sbKey(),
          Authorization: `Bearer ${sbKey()}`
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
      return res.status(500).json({ ok: false, error: "server_error" });
    }

    return res.json({ ok: true, data });
  } catch (e) {
    console.error("add-video-link error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ===================== AI PRACTICE =====================
const aiService = require("./services/aiService");
const aiUsage  = require("./services/aiUsageService");

app.get("/api/ai/debug", requireAdmin, async (req, res) => {
  const report = {
    OPENAI_API_KEY:       !!process.env.OPENAI_API_KEY,
    SUPABASE_URL:         !!process.env.SUPABASE_URL,
    SUPABASE_KEY:         !!process.env.SUPABASE_KEY,
    SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
    keyUsedForAiUsage:    process.env.SUPABASE_SERVICE_KEY ? "service_role" : "anon"
  };

  // Test ai_daily_usage table access
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
    const r = await fetch(`${url}/rest/v1/ai_daily_usage?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    const body = await r.text();
    report.supabaseAiTable = { status: r.status, ok: r.ok, body: body.slice(0, 200) };
  } catch (e) {
    report.supabaseAiTable = { error: e.message };
  }

  // Test OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.responses.create({
        model: "gpt-5.5-mini",
        input: "Say hello in Kazakh in one word"
      });
      report.openaiTest = { ok: true, text: (response.output_text || "").trim().slice(0, 100) };
    } catch (e) {
      report.openaiTest = { ok: false, error: e.message, status: e?.status };
    }
  } else {
    report.openaiTest = { ok: false, error: "OPENAI_API_KEY not set" };
  }

  return res.json(report);
});

app.get("/api/ai/usage", requireAuth, async (req, res) => {
  try {
    const studentId = String(req.session?.user?.studentId || "");
    const lessonId  = String(req.query.lessonId || "").trim();
    console.log(`[ai/usage] studentId=${studentId} lessonId=${lessonId}`);
    if (!studentId || !lessonId) {
      return res.status(400).json({ ok: false, error: "bad_input" });
    }
    const usage = await aiUsage.getUsage(studentId, lessonId);
    return res.json({ ok: true, ...usage, limit: aiUsage.DAILY_LIMIT });
  } catch (e) {
    console.error("[ai/usage] error:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/ai/practice", aiLimiter, requireAuth, async (req, res) => {
  try {
    const { grade, subject, lessonId, todayTopics, promptType, lessonKey } = req.body || {};
    const studentId = String(req.session?.user?.studentId || "");

    console.log(`[ai/practice] START | studentId=${studentId} grade=${grade} subject=${subject} lessonId=${lessonId} promptType=${promptType} lessonKey=${lessonKey}`);

    if (!aiService.ALLOWED_PROMPT_TYPES.includes(promptType)) {
      console.log(`[ai/practice] invalid promptType: ${promptType}`);
      return res.status(400).json({ ok: false, error: "invalid_prompt_type" });
    }

    const g  = String(grade       || "").trim();
    const s  = String(subject     || "").trim();
    const l  = String(lessonId    || "").trim();
    const lk = String(lessonKey   || `${g}_${s}_${l}`).trim();
    const topics = String(todayTopics || "").slice(0, 300).trim();

    if (!g || !s) {
      console.log(`[ai/practice] missing grade/subject | g=${g} s=${s}`);
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    if (!studentId) {
      console.log("[ai/practice] no studentId in session (admin?)");
      return res.status(400).json({ ok: false, error: "missing_student_id" });
    }

    // ── Step 1: read today's count ───────────────────────────────────────────
    console.log(`[ai/practice] reading usage | studentId=${studentId} lk=${lk}`);
    const usage = await aiUsage.getUsage(studentId, lk);
    console.log(`[ai/practice] usage read | count=${usage.count} limit=${aiUsage.DAILY_LIMIT} remaining=${usage.remaining}`);

    // ── Step 2: block only when count >= DAILY_LIMIT ──────────────────────────
    if (usage.count >= aiUsage.DAILY_LIMIT) {
      console.log(`[ai/practice] BLOCKED — GoTAB daily limit reached | count=${usage.count} >= limit=${aiUsage.DAILY_LIMIT}`);
      return res.status(429).json({
        ok: false,
        error: "daily_limit_reached",
        count: usage.count,
        remaining: 0,
        limit: aiUsage.DAILY_LIMIT
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      console.error("[ai/practice] OPENAI_API_KEY not set");
      return res.status(500).json({ ok: false, error: "ai_no_key" });
    }

    console.log(`[ai/practice] ALLOWED — count=${usage.count} < limit=${aiUsage.DAILY_LIMIT} | calling OpenAI now | model=gpt-5.5-mini`);

    // ── Step 3: call OpenAI ──────────────────────────────────────────────────
    const result = await aiService.generateProblems({ grade: g, subject: s, lessonId: l, todayTopics: topics, promptType });
    console.log(`[ai/practice] OpenAI response received | textLength=${result.text.length}`);

    // ── Step 4: only increment AFTER successful OpenAI response ──────────────
    const newUsage = await aiUsage.incrementUsage(studentId, lk);
    console.log(`[ai/practice] usage after increment | count=${newUsage.count} remaining=${newUsage.remaining}`);

    return res.json({
      ok: true,
      text: result.text,
      title: result.title,
      count: newUsage.count,
      remaining: newUsage.remaining,
      limit: aiUsage.DAILY_LIMIT
    });
  } catch (e) {
    const errMsg  = String(e?.message || "");
    const errCode = Number(e?.status ?? e?.response?.status ?? 0);

    const openAiCode = e?.error?.code || "";
    console.error("[ai/practice] ERROR DETAILS:");
    console.error("  status    :", errCode);
    console.error("  openai_code:", openAiCode);
    console.error("  message   :", errMsg);
    console.error("  error body:", JSON.stringify(e?.error ?? null));
    console.error("  toString  :", e.toString());
    console.error("  stack     :\n" + e.stack);

    // Billing / no credit (HTTP 429 with insufficient_quota)
    if (errCode === 429 && openAiCode === "insufficient_quota") {
      console.error("[ai/practice] OpenAI insufficient_quota — billing/credit not set up");
      return res.status(402).json({ ok: false, error: "ai_no_credit" });
    }

    // Invalid API key (HTTP 401)
    if (errCode === 401) {
      console.error("[ai/practice] OpenAI 401 — invalid or missing API key");
      return res.status(500).json({ ok: false, error: "ai_no_key" });
    }

    // Rate limit (HTTP 429, not billing)
    if (errCode === 429) {
      console.error("[ai/practice] OpenAI returned HTTP 429 — rate limit");
      return res.status(429).json({ ok: false, error: "ai_rate_limit" });
    }

    return res.status(500).json({ ok: false, error: "ai_error" });
  }
});


// ===================== QUIZ =====================
const quizParser = require("./services/quizParser");

function quizDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  return { url, key };
}

const _QUIZ_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS quizzes (
  id            bigint primary key generated always as identity,
  package       text    not null,
  grade         int     not null,
  subject       text    not null,
  lesson_number int     not null,
  raw_text      text    not null,
  parsed_questions jsonb not null,
  updated_at    timestamptz default now(),
  unique(package, grade, subject, lesson_number)
);`;

const _ATTEMPTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id             bigint primary key generated always as identity,
  quiz_id        bigint references quizzes(id) on delete set null,
  student_id     text    not null,
  student_name   text,
  package        text,
  grade          int,
  subject        text,
  lesson_number  int,
  correct_count  int,
  wrong_count    int,
  total_count    int,
  percentage     int,
  topic_breakdown  jsonb,
  wrong_questions  jsonb,
  ai_diagnosis   text,
  answers        jsonb,
  created_at     timestamptz default now()
);`;

async function ensureQuizTables() {
  const { url, key } = quizDb();
  if (!url || !key) {
    console.error("[quiz-setup] SUPABASE_URL or key not set — skipping table check.");
    return;
  }

  // Check if quizzes table exists via REST
  let tableExists = false;
  try {
    const probe = await fetch(`${url}/rest/v1/quizzes?limit=0`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const probeBody = await probe.json().catch(() => null);
    if (probe.ok) {
      tableExists = true;
      console.log("[quiz-setup] quizzes table: EXISTS");
    } else {
      console.error("[quiz-setup] quizzes table probe failed:");
      console.error("  status :", probe.status);
      console.error("  message:", probeBody?.message);
      console.error("  code   :", probeBody?.code);
      console.error("  hint   :", probeBody?.hint);
    }
  } catch (e) {
    console.error("[quiz-setup] probe fetch error:", e.message);
  }

  if (tableExists) return;

  // Attempt auto-create via DATABASE_URL (direct Postgres connection)
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    console.log("[quiz-setup] Attempting auto-create via DATABASE_URL ...");
    let pgClient;
    try {
      const { Client } = require("pg");
      pgClient = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
      await pgClient.connect();
      await pgClient.query(_QUIZ_TABLE_SQL);
      console.log("[quiz-setup] quizzes table created OK");
      await pgClient.query(_ATTEMPTS_TABLE_SQL);
      console.log("[quiz-setup] quiz_attempts table created OK");
      await pgClient.end();
      console.log("[quiz-setup] Auto-create DONE. Tables are ready.");
      return;
    } catch (pgErr) {
      console.error("[quiz-setup] pg auto-create failed:", pgErr.message);
      if (pgClient) await pgClient.end().catch(() => {});
    }
  } else {
    console.warn("[quiz-setup] DATABASE_URL not set — cannot auto-create tables.");
  }

  // Fallback: print SQL for manual execution
  console.error("=".repeat(60));
  console.error("[quiz-setup] ACTION REQUIRED: run this SQL in Supabase SQL Editor:");
  console.error(_QUIZ_TABLE_SQL);
  console.error(_ATTEMPTS_TABLE_SQL);
  console.error("=".repeat(60));
}

async function generateQuizDiagnosis({ grade, subject, lessonNumber, totalCount, correctCount, wrongCount, percentage, wrongQuestions, topicBreakdown }) {
  const weakTopics   = Object.entries(topicBreakdown).filter(([,d]) => d.percentage < 50).map(([t]) => t);
  const strongTopics = Object.entries(topicBreakdown).filter(([,d]) => d.percentage >= 80).map(([t]) => t);

  const fallbackLines = [
    `Диагностика:`,
    `Жалпы нәтиже: ${correctCount}/${totalCount} (${percentage}%).`,
    ``,
    `Әлсіз тақырыптар:`,
    weakTopics.length   ? weakTopics.map(t => `- ${t}`).join("\n")   : "- Жоқ",
    ``,
    `Жақсы меңгерген тақырыптар:`,
    strongTopics.length ? strongTopics.map(t => `- ${t}`).join("\n") : "- Жоқ",
    ``,
    `Мұғалімге кеңес:`,
    weakTopics.length
      ? weakTopics.map(t => `- "${t}" тақырыбын қайталату ұсынылады.`).join("\n")
      : "- Барлық тақырып жақсы меңгерілген.",
    ``,
    `Қосымша тапсырма ұсынысы:`,
    weakTopics.length
      ? `- ${weakTopics.join(", ")} бойынша 2 жеңіл, 2 орташа, 1 күрделі есеп.`
      : "- Жаңа тақырыпқа өтуге болады.",
  ];
  const fallbackDiagnosis = fallbackLines.join("\n");
  const fallbackAdvice = weakTopics.length
    ? `Қосымша жаттығу ұсынылады: ${weakTopics.join(", ")}.`
    : "Оқушы материалды жақсы меңгерген.";

  if (!process.env.OPENAI_API_KEY) {
    return { diagnosis: "ИИ диагностика уақытша қолжетімсіз. Төменде автоматты базалық анализ көрсетілді.\n\n" + fallbackDiagnosis, advice: fallbackAdvice };
  }

  try {
    const { resolveModel } = require("./services/aiService");
    const model = await resolveModel();
    const OpenAI = require("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const topicSummary = Object.entries(topicBreakdown)
      .map(([t, d]) => `${t}: ${d.correct}/${d.total} (${d.percentage}%)`).join("\n");
    const wrongSummary = wrongQuestions.slice(0, 10)
      .map(wq => `Сұрақ: "${wq.question}" | Дұрыс: "${wq.correct}" | Оқушы: "${wq.studentAnswer || "(жоқ)"}"`).join("\n");

    const prompt = [
      `GoTAB математика сынақ нәтижесі. ${grade}-сынып, ${subject}, ${lessonNumber}-сабақ.`,
      `Нәтиже: ${correctCount}/${totalCount} (${percentage}%).`,
      ``, `Тақырыптар бойынша нәтиже:`, topicSummary,
      ``, `Қате жіберілген сұрақтар:`, wrongSummary || "(қате жоқ)",
      ``,
      `Мұғалімге арналған диагностика жасаңыз. Тек осы деректер негізінде. Форматы:`,
      `Диагностика:\n(жалпы баға)\n\nӘлсіз тақырыптар:\n- (тізім)\n\nЖақсы меңгерген тақырыптар:\n- (тізім)\n\nҚате себептері:\n- (тізім)\n\nМұғалімге кеңес:\n- (тізім)\n\nҚосымша тапсырма ұсынысы:\n- 2 жеңіл есеп\n- 2 орташа есеп\n- 1 күрделі есеп`,
    ].join("\n");

    const resp = await client.responses.create({
      model,
      instructions: "Сен GoTAB математика мұғалімісің. Тек қазақ тілінде жауап бер. Диагностика нақты және қысқа болуы керек.",
      input: prompt,
    });

    const text = (resp.output_text || "").trim();
    if (text) return { diagnosis: text, advice: fallbackAdvice };
  } catch (aiErr) {
    console.error("[quiz/diagnosis] OpenAI error:", aiErr.message);
  }

  return {
    diagnosis: "ИИ диагностика уақытша қолжетімсіз. Төменде автоматты базалық анализ көрсетілді.\n\n" + fallbackDiagnosis,
    advice: fallbackAdvice,
  };
}

// Admin: save / update quiz
app.post("/api/quiz/admin/save", requireAdmin, async (req, res) => {
  const TABLE = "quizzes";
  console.log("[quiz/save] ── incoming request ──");
  console.log("[quiz/save] body:", JSON.stringify(req.body || {}));

  try {
    const { package: pkg, grade, subject, lessonNumber, rawText } = req.body || {};

    if (!pkg || !grade || !subject || !lessonNumber || !rawText) {
      console.warn("[quiz/save] validation failed: missing fields", { pkg: !!pkg, grade: !!grade, subject: !!subject, lessonNumber: !!lessonNumber, rawText: !!rawText });
      return res.status(400).json({ ok: false, error: "Барлық өрістерді толтырыңыз." });
    }

    const ln = Number(lessonNumber);
    if (!Number.isFinite(ln) || ln < 1) {
      console.warn("[quiz/save] validation failed: bad lessonNumber:", lessonNumber);
      return res.status(400).json({ ok: false, error: "Сабақ нөмірі дұрыс емес." });
    }

    const parsed = quizParser.parseQuiz(rawText);
    console.log("[quiz/save] parse result: ok=%s questions=%d errors=%j", parsed.ok, parsed.questions?.length, parsed.errors);
    if (!parsed.ok) return res.status(400).json({ ok: false, errors: parsed.errors });

    const { url, key } = quizDb();
    console.log("[quiz/save] supabase url:", url ? url.slice(0, 50) + "..." : "MISSING");
    console.log("[quiz/save] key present:", !!key, "| table:", TABLE);

    const rowData = {
      package:          pkg,
      grade:            Number(grade),
      subject:          String(subject),
      lesson_number:    ln,
      raw_text:         rawText,
      parsed_questions: parsed.questions,
      updated_at:       new Date().toISOString(),
    };
    console.log("[quiz/save] payload (sans raw_text): pkg=%s grade=%s subject=%s lesson=%s questions=%d",
      pkg, grade, subject, ln, parsed.questions.length);

    // Prefer: resolution=merge-duplicates fails with anon key when row exists (returns 409).
    // Instead: find existing row → PATCH it; otherwise INSERT.
    const findR = await fetch(
      `${url}/rest/v1/${TABLE}?select=id&package=eq.${encodeURIComponent(pkg)}&grade=eq.${Number(grade)}&subject=eq.${encodeURIComponent(subject)}&lesson_number=eq.${ln}&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const findRows = await findR.json().catch(() => []);
    const existingId = Array.isArray(findRows) ? findRows[0]?.id : null;
    console.log("[quiz/save] existingId:", existingId || "none (new insert)");

    let r, data;
    if (existingId) {
      r = await fetch(`${url}/rest/v1/${TABLE}?id=eq.${existingId}`, {
        method:  "PATCH",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify(rowData),
      });
    } else {
      r = await fetch(`${url}/rest/v1/${TABLE}`, {
        method:  "POST",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify([rowData]),
      });
    }

    console.log("[quiz/save] supabase HTTP status:", r.status, r.statusText);
    data = await r.json().catch(() => null);

    if (!r.ok) {
      console.error("[quiz/save] Supabase error:", JSON.stringify(data));
      return res.status(500).json({
        ok: false,
        error: "db_error",
        supabase: {
          code:    data?.code    || String(r.status),
          message: data?.message || data?.hint || "unknown error",
          hint:    data?.hint    || "",
        },
      });
    }

    console.log(`[quiz/save] OK — pkg=${pkg} grade=${grade} subject=${subject} lesson=${ln} questions=${parsed.questions.length} op=${existingId ? "update" : "insert"}`);
    return res.json({ ok: true, questionCount: parsed.questions.length, warnings: parsed.errors });

  } catch (e) {
    console.error("[quiz/save] server exception:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Admin: get quiz with correct answers
app.get("/api/quiz/admin/get", requireAdmin, async (req, res) => {
  try {
    const { package: pkg, grade, subject, lessonNumber } = req.query;
    const ln = Number(lessonNumber);
    if (!pkg || !grade || !subject || !ln) return res.status(400).json({ ok: false, error: "bad_input" });
    const { url, key } = quizDb();
    const r = await fetch(
      `${url}/rest/v1/quizzes?select=*&package=eq.${encodeURIComponent(pkg)}&grade=eq.${encodeURIComponent(grade)}&subject=eq.${encodeURIComponent(subject)}&lesson_number=eq.${ln}&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const rows = await r.json().catch(() => []);
    if (!r.ok) return res.status(500).json({ ok: false, error: "db_error" });
    return res.json({ ok: true, quiz: rows[0] || null });
  } catch (e) {
    console.error("[quiz/admin/get] error:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Admin: list quizzes
app.get("/api/quiz/admin/list", requireAdmin, async (req, res) => {
  try {
    const { url, key } = quizDb();
    const r = await fetch(`${url}/rest/v1/quizzes?select=id,package,grade,subject,lesson_number,updated_at&order=updated_at.desc`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json().catch(() => []);
    if (!r.ok) {
      const msg = Array.isArray(rows) ? "db_error" : (rows?.message || rows?.hint || "db_error");
      return res.status(500).json({ ok: false, error: msg });
    }
    return res.json({ ok: true, quizzes: rows });
  } catch (e) {
    console.error("[quiz/admin/list] error:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Admin: quiz health check — verifies tables are accessible
app.get("/api/quiz/admin/health", requireAdmin, async (req, res) => {
  try {
    const { url, key } = quizDb();
    const [rQ, rA] = await Promise.all([
      fetch(`${url}/rest/v1/quizzes?select=id&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }),
      fetch(`${url}/rest/v1/quiz_attempts?select=id&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }),
    ]);
    const dQ = await rQ.json().catch(() => null);
    const dA = await rA.json().catch(() => null);
    return res.json({
      ok: rQ.ok && rA.ok,
      quizzes:       { status: rQ.status, ok: rQ.ok, error: rQ.ok ? null : (dQ?.message || dQ?.hint || "table missing") },
      quiz_attempts: { status: rA.status, ok: rA.ok, error: rA.ok ? null : (dA?.message || dA?.hint || "table missing") },
      keyType: process.env.SUPABASE_SERVICE_KEY ? "service_role" : "anon",
    });
  } catch (e) {
    console.error("[quiz/admin/health] error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Admin: delete quiz
app.delete("/api/quiz/admin/delete/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "bad_id" });
    const { url, key } = quizDb();
    const r = await fetch(`${url}/rest/v1/quizzes?id=eq.${id}`, {
      method: "DELETE",
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return res.status(500).json({ ok: false, error: "db_error" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("[quiz/admin/delete] error:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Admin: list attempts (with optional filters)
app.get("/api/quiz/admin/attempts", requireAdmin, async (req, res) => {
  try {
    const { studentId, package: pkg, grade, subject, lessonNumber } = req.query;
    const { url, key } = quizDb();
    let endpoint = `${url}/rest/v1/quiz_attempts?select=id,quiz_id,student_id,student_name,package,grade,subject,lesson_number,correct_count,wrong_count,total_count,percentage,topic_breakdown,created_at&order=created_at.desc&limit=200`;
    if (studentId)    endpoint += `&student_id=eq.${encodeURIComponent(studentId)}`;
    if (pkg)          endpoint += `&package=eq.${encodeURIComponent(pkg)}`;
    if (grade)        endpoint += `&grade=eq.${encodeURIComponent(grade)}`;
    if (subject)      endpoint += `&subject=eq.${encodeURIComponent(subject)}`;
    if (lessonNumber) endpoint += `&lesson_number=eq.${Number(lessonNumber)}`;
    const r = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json().catch(() => []);
    if (!r.ok) return res.status(500).json({ ok: false, error: "db_error" });
    return res.json({ ok: true, attempts: rows });
  } catch (e) {
    console.error("[quiz/admin/attempts] error:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Admin: get full attempt (with diagnosis)
app.get("/api/quiz/admin/attempt/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "bad_id" });
    const { url, key } = quizDb();
    const r = await fetch(`${url}/rest/v1/quiz_attempts?id=eq.${id}&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json().catch(() => []);
    if (!r.ok) return res.status(500).json({ ok: false, error: "db_error" });
    const attempt = rows[0];
    if (!attempt) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, attempt });
  } catch (e) {
    console.error("[quiz/admin/attempt] error:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Student: get quiz (no correct answers)
app.get("/api/quiz/student", requireAuth, async (req, res) => {
  try {
    const { package: pkg, grade, subject, lessonNumber } = req.query;
    const ln = Number(lessonNumber);
    if (!pkg || !grade || !subject || !ln) return res.status(400).json({ ok: false, error: "bad_input" });
    const { url, key } = quizDb();
    const r = await fetch(
      `${url}/rest/v1/quizzes?select=id,lesson_number,parsed_questions&package=eq.${encodeURIComponent(pkg)}&grade=eq.${encodeURIComponent(grade)}&subject=eq.${encodeURIComponent(subject)}&lesson_number=eq.${ln}&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const rows = await r.json().catch(() => []);
    if (!r.ok) return res.status(500).json({ ok: false, error: "db_error" });
    const quiz = rows[0];
    if (!quiz) return res.json({ ok: true, quiz: null });
    const questions = quizParser.questionsForStudent(quiz.parsed_questions || []);
    return res.json({ ok: true, quiz: { id: quiz.id, lessonNumber: quiz.lesson_number, total: questions.length, questions } });
  } catch (e) {
    console.error("[quiz/student] error:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Student: submit quiz
app.post("/api/quiz/submit", requireAuth, async (req, res) => {
  try {
    const { quizId, answers } = req.body || {};
    const studentId   = String(req.session?.user?.studentId || "");
    const studentName = String(req.session?.user?.fullName  || "");

    if (!quizId || !Array.isArray(answers)) return res.status(400).json({ ok: false, error: "bad_input" });
    if (!studentId) return res.status(400).json({ ok: false, error: "missing_student_id" });

    const { url, key } = quizDb();
    const qr = await fetch(`${url}/rest/v1/quizzes?id=eq.${Number(quizId)}&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const qrows = await qr.json().catch(() => []);
    if (!qr.ok || !qrows[0]) return res.status(404).json({ ok: false, error: "quiz_not_found" });

    const quiz   = qrows[0];
    const parsed = quiz.parsed_questions || [];

    let correctCount = 0, wrongCount = 0;
    const wrongQuestions = [];
    const topicMap = {};

    parsed.forEach((q, idx) => {
      const studentAnswer = String(answers[idx] || "").trim();
      const isCorrect = studentAnswer === q.correct;
      if (!topicMap[q.topic]) topicMap[q.topic] = { total: 0, correct: 0, wrong: 0 };
      topicMap[q.topic].total++;
      if (isCorrect) { correctCount++; topicMap[q.topic].correct++; }
      else           { wrongCount++;   topicMap[q.topic].wrong++;
        wrongQuestions.push({ idx, question: q.question, topic: q.topic, correct: q.correct, studentAnswer, options: q.options });
      }
    });

    const totalCount = parsed.length;
    const percentage = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;

    const topicBreakdown = {};
    for (const [topic, d] of Object.entries(topicMap)) {
      topicBreakdown[topic] = { total: d.total, correct: d.correct, wrong: d.wrong, percentage: Math.round((d.correct / d.total) * 100) };
    }

    let message;
    if      (percentage >= 90) message = "Тамаша! Өте жақсы нәтиже 🏆";
    else if (percentage >= 70) message = "Жарайсың! Бірақ қате кеткен тақырыптарды қайталап шық 💪";
    else if (percentage >= 50) message = "Жақсы әрекет! Дайындалуды жалғастыр 📚";
    else                       message = "Тапсырмаларды қайта оқып шық. Болады! 🌱";

    // AI diagnosis (non-blocking)
    let aiDiagnosis = "", teacherAdvice = "";
    try {
      const d = await generateQuizDiagnosis({ grade: quiz.grade, subject: quiz.subject, lessonNumber: quiz.lesson_number, totalCount, correctCount, wrongCount, percentage, wrongQuestions, topicBreakdown });
      aiDiagnosis   = d.diagnosis;
      teacherAdvice = d.advice;
    } catch (diagErr) { console.error("[quiz/submit] diagnosis:", diagErr.message); }

    const attempt = { quiz_id: Number(quizId), student_id: studentId, student_name: studentName, package: quiz.package, grade: quiz.grade, subject: quiz.subject, lesson_number: quiz.lesson_number, answers, correct_count: correctCount, wrong_count: wrongCount, total_count: totalCount, percentage, wrong_questions: wrongQuestions, topic_breakdown: topicBreakdown, ai_diagnosis: aiDiagnosis, teacher_advice: teacherAdvice };
    const ar = await fetch(`${url}/rest/v1/quiz_attempts`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify([attempt]),
    });
    if (!ar.ok) console.error("[quiz/submit] save attempt error:", await ar.text().catch(() => ""));

    console.log(`[quiz/submit] student=${studentId} quiz=${quizId} ${correctCount}/${totalCount} (${percentage}%)`);
    return res.json({ ok: true, correctCount, wrongCount, totalCount, percentage, message });
  } catch (e) {
    console.error("[quiz/submit] error:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ===================== MESSAGES (Two-way feedback) =====================
// Messages are stored in the existing `notifications` table using special type values:
//   chat_out  = message from student to teacher
//   chat_in   = reply from admin/teacher to student
// No separate table is needed; notifications table is confirmed to exist.

// GET /api/messages?studentId=X
app.get("/api/messages", requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session?.user;
    const requestedId = String(req.query.studentId || "").trim();
    const studentId = sessionUser.role === "admin"
      ? requestedId
      : String(sessionUser.studentId || "").trim();
    if (!studentId) return res.status(400).json({ ok: false, error: "bad_input" });
    if (sessionUser.role !== "admin" && requestedId && requestedId !== studentId)
      return res.status(403).json({ ok: false, error: "forbidden" });
    const key = sbKey();
    const endpoint = `${SUPABASE_URL}/rest/v1/notifications`
      + `?select=id,type,text,created_at`
      + `&student_id=eq.${encodeURIComponent(studentId)}`
      + `&type=in.(chat_out,chat_in)`
      + `&order=created_at.asc&limit=100`;
    const r = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json().catch(() => []);
    if (!r.ok) { console.error("[messages/get] supabase error:", rows); return res.status(500).json({ ok: false, error: "server_error" }); }
    const messages = (Array.isArray(rows) ? rows : []).map(n => ({
      id: n.id,
      author: n.type === "chat_out" ? "student" : "admin",
      message: n.text,
      created_at: n.created_at
    }));
    return res.json({ ok: true, messages });
  } catch (e) { console.error("[messages/get]", e.message); return res.status(500).json({ ok: false, error: "server_error" }); }
});

// POST /api/messages/send
app.post("/api/messages/send", requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session?.user;
    const { studentId: bodyStudentId, message } = req.body || {};
    const msgText = String(message || "").trim();
    if (!msgText || msgText.length > 2000) return res.status(400).json({ ok: false, error: "bad_input" });
    let studentId, msgType;
    if (sessionUser.role === "admin") {
      studentId = String(bodyStudentId || "").trim();
      msgType = "chat_in";
    } else {
      studentId = String(sessionUser.studentId || "").trim();
      msgType = "chat_out";
    }
    if (!studentId) return res.status(400).json({ ok: false, error: "bad_input" });
    const key = sbKey();
    const row = {
      id: "cm_" + Date.now() + "_" + Math.random().toString(16).slice(2, 8),
      student_id: studentId,
      type: msgType,
      text: msgText,
      read: false
    };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify([row]),
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); console.error("[messages/send]", t); return res.status(500).json({ ok: false, error: "server_error" }); }
    return res.json({ ok: true });
  } catch (e) { console.error("[messages/send]", e.message); return res.status(500).json({ ok: false, error: "server_error" }); }
});

// POST /api/student/mark-activity
// Called by blocks pages immediately after each activity completes.
// action: "watched" | "uploaded" | "tested" | "ai"
// Stores an explicit signal in the notifications table (always exists, proven working).
// This is the authoritative source for checklist completion.
app.post("/api/student/mark-activity", requireStudent, async (req, res) => {
  try {
    const studentId = String(req.session?.user?.studentId || "").trim();
    const action = String(req.body?.action || "").trim();
    if (!studentId || !["watched", "uploaded", "tested", "ai"].includes(action)) {
      return res.status(400).json({ ok: false, error: "bad_input" });
    }
    const key = sbKey();
    const row = {
      id: "act_" + action + "_" + Date.now() + "_" + Math.random().toString(16).slice(2, 6),
      student_id: studentId,
      type: "act_" + action,
      text: new Date().toISOString().slice(0, 10), // store date for future date-based filtering
      read: true
    };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify([row]),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("[mark-activity]", action, t);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
    return res.json({ ok: true });
  } catch (e) { console.error("[mark-activity]", e.message); return res.status(500).json({ ok: false, error: "server_error" }); }
});

// Keep backward-compat alias used by older blocks page code
app.post("/api/student/mark-video-watched", requireStudent, async (req, res) => {
  req.body = req.body || {};
  req.body.action = "watched";
  // Re-use mark-activity handler by forwarding internally
  try {
    const studentId = String(req.session?.user?.studentId || "").trim();
    if (!studentId) return res.status(400).json({ ok: false, error: "bad_input" });
    const key = sbKey();
    const row = {
      id: "act_watched_" + Date.now() + "_" + Math.random().toString(16).slice(2, 6),
      student_id: studentId, type: "act_watched",
      text: new Date().toISOString().slice(0, 10), read: true
    };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify([row]),
    });
    if (!r.ok) return res.status(500).json({ ok: false, error: "server_error" });
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ ok: false, error: "server_error" }); }
});

// Shared activity query helper
// Primary source: explicit act_* signals in notifications (written by mark-activity).
// Fallback: actual database tables (progress, quiz_attempts, ai_daily_usage).
// Returns true if EITHER source confirms completion.
async function queryStudentActivity(studentId) {
  const key = sbKey();
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const [sigR, progR, quizR, aiR] = await Promise.all([
    // Primary: explicit activity signals
    fetch(`${SUPABASE_URL}/rest/v1/notifications?select=type&student_id=eq.${encodeURIComponent(studentId)}&type=in.(act_watched,act_uploaded,act_tested,act_ai,daily_watch)&limit=20`, { headers: h }),
    // Fallback: actual tables
    fetch(`${SUPABASE_URL}/rest/v1/progress?select=status&student_id=eq.${encodeURIComponent(studentId)}&limit=100`, { headers: h }),
    fetch(`${SUPABASE_URL}/rest/v1/quiz_attempts?select=id&student_id=eq.${encodeURIComponent(studentId)}&limit=1`, { headers: h }),
    fetch(`${SUPABASE_URL}/rest/v1/ai_daily_usage?select=id&student_id=eq.${encodeURIComponent(studentId)}&limit=1`, { headers: h }),
  ]);
  const [sigRows, progRows, quizRows, aiRows] = await Promise.all([
    sigR.json().catch(() => []),
    progR.json().catch(() => []),
    quizR.json().catch(() => []),
    aiR.json().catch(() => []),
  ]);
  const sigs = new Set(Array.isArray(sigRows) ? sigRows.map(r => String(r.type || "")) : []);
  const uploadStatuses = ["uploaded", "reviewing", "graded", "checked"];
  return {
    watched:  sigs.has("act_watched") || sigs.has("daily_watch"),
    uploaded: sigs.has("act_uploaded") || (Array.isArray(progRows) && progRows.some(r => uploadStatuses.includes(String(r.status || "").toLowerCase()))),
    tested:   sigs.has("act_tested")  || (Array.isArray(quizRows) && quizRows.length > 0),
    ai:       sigs.has("act_ai")      || (Array.isArray(aiRows) && aiRows.length > 0),
  };
}

// GET /api/student-activity  (authenticated student — uses session, no query param)
app.get("/api/student-activity", requireAuth, async (req, res) => {
  try {
    const sessionUser = req.session?.user;
    if (sessionUser.role === "admin")
      return res.status(403).json({ ok: false, error: "forbidden" });
    const studentId = String(sessionUser.studentId || "").trim();
    if (!studentId) return res.status(400).json({ ok: false, error: "bad_input" });
    const activity = await queryStudentActivity(studentId);
    return res.json({ ok: true, ...activity });
  } catch (e) { console.error("[student-activity]", e.message); return res.status(500).json({ ok: false, error: "server_error" }); }
});

// GET /api/admin/student-activity?studentId=X  (for preview checklist)
app.get("/api/admin/student-activity", requireAdmin, async (req, res) => {
  try {
    const studentId = String(req.query.studentId || "").trim();
    if (!studentId) return res.status(400).json({ ok: false, error: "bad_input" });
    const activity = await queryStudentActivity(studentId);
    return res.json({ ok: true, ...activity });
  } catch (e) { console.error("[admin/student-activity]", e.message); return res.status(500).json({ ok: false, error: "server_error" }); }
});

// ===================== START =====================
// Discover the best available OpenAI model before serving any requests
aiService.resolveModel().catch(e => console.error("[startup] model discovery error:", e.message));

// Ensure quiz DB tables exist (auto-creates via DATABASE_URL if missing)
ensureQuizTables().catch(e => console.error("[startup] ensureQuizTables error:", e.message));

// Messaging now uses the notifications table — no separate table setup needed.

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
