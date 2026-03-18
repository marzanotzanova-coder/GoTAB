process.env.TZ = "Asia/Almaty";

// server.js (GoTAB LMS Core - WORKING FULL)
const express = require("express");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const avatarStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/avatars");
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
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
app.use("/uploads", express.static("uploads"));

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

app.get("/api/auth/me", (req,res)=>{
  const u = req.session?.user || null;
  return res.json({ ok:true, user: u });
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
 if(role === "student"){
  const phone = String(req.body?.phone || "").trim();
  const password = String(req.body?.password || "");

  if(!phone || !password){
    return res.status(400).json({ ok:false, error:"missing_fields" });
  }

  const db = readDB();
  const users = Array.isArray(db.users) ? db.users : [];

  const st = users.find(x => String(x.phone || "") === phone);

  if(!st){
    return res.status(401).json({ ok:false, error:"student_not_found" });
  }

  const ok = await bcrypt.compare(password, st.passwordHash);

  if(!ok){
    return res.status(401).json({ ok:false, error:"bad_credentials" });
  }

  const sid = String(st.studentId || "").trim();
  const pkg = String(st.package || "baza").toLowerCase();

  req.session.user = {
  role:"student",
  studentId: sid,
  package: pkg,
  grade: Number(st.grade || 5),
  fullName: st.fullName || "Оқушы",
  phone: st.phone || "",
  email: st.email || "",
  avatar: st.avatar || ""
};

  return res.json({ ok:true, user: req.session.user });
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

function pushNotif(db, studentId, type, text) {
  db.notifications = db.notifications || {};
  db.notifications[studentId] = db.notifications[studentId] || [];
  db.notifications[studentId].unshift({
    id: "n_" + Date.now() + "_" + Math.random().toString(16).slice(2),
    type,
    text,
    createdAt: nowISO(),
    read: false,
  });
  db.notifications[studentId] = db.notifications[studentId].slice(0, 50);
}

// Register
app.post("/api/auth/register", async (req, res) => {
  try{
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

    const db = readDB();

    const exists = db.users.find(
      (u) => String(u.phone || "").trim() === String(phone || "").trim()
    );

    if (exists) {
      return res.status(409).json({ ok: false, error: "phone_exists" });
    }

    const studentId = makeStudentId(phone, email);
    const passwordHash = await bcrypt.hash(String(password), 10);

    const user = {
  studentId,
  fullName: `${String(firstName).trim()} ${String(lastName).trim()}`.trim(),
  firstName: String(firstName).trim(),
  lastName: String(lastName).trim(),
  phone: String(phone).trim(),
  email: String(email).trim().toLowerCase(),
  passwordHash,
  grade: 5,
  package: "pending"
};

    db.users.push(user);

    db.progress[studentId] = db.progress[studentId] || {};
    db.notifications[studentId] = db.notifications[studentId] || [];
    db.streak[studentId] = db.streak[studentId] || {
      lastVisitDate: "",
      current: 0,
      best: 0,
      totalLogins: 0,
    };

    pushNotif(db, studentId, "welcome", `Қош келдің, ${user.fullName}! Аккаунтың ашылды ✅`);
    pushNotif(db, studentId, "package", `Пакетіңіз әлі бекітілмеді. Төлем тексерілген соң курс ашылады ⏳`);

    writeDB(db);

   req.session.user = {
  role: "student",
  studentId: user.studentId,
  package: user.package,
  grade: Number(user.grade || 5),
  fullName: user.fullName,
  phone: user.phone,
  email: user.email,
  avatar: user.avatar || ""
};
    return res.json({
      ok: true,
      user: req.session.user
    });
  }catch(e){
    console.error("register error", e);
    return res.status(500).json({ ok:false, error:"server_error" });
  }
});
// ===================== ADMIN: STUDENTS LIST =====================
app.get("/api/admin/students", requireAdmin, (req, res) => {
  const db = readDB();
  const students = (db.users || []).map((u) => ({
    studentId: u.studentId,
    fullName: u.fullName,
    phone: u.phone,
    email: u.email,
    package: u.package || "pending",
    grade: Number(u.grade || 5),
    avatar: u.avatar || "",
  }));
  res.json({ ok: true, students });
});

app.post("/api/admin/set-package", requireAdmin, (req,res)=>{
  const db = readDB();
  const studentId = String(req.body?.studentId || "").trim();
  let pkg = String(req.body?.package || "").trim().toLowerCase();

  if(pkg === "baza") pkg = "base";
  if(pkg === "standard") pkg = "standart";

  if(!["pending","base","standart","premium"].includes(pkg)){
    return res.status(400).json({ok:false,error:"bad_package"});
  }

  const user = db.users.find(x => String(x.studentId || "") === studentId);
  if(!user){
    return res.status(404).json({ok:false,error:"student_not_found"});
  }

  user.package = pkg;
  writeDB(db);

  return res.json({ok:true});
});

app.post("/api/admin/set-student-meta", requireAdmin, (req,res)=>{
  const db = readDB();
  const studentId = String(req.body?.studentId || "").trim();
  let pkg = String(req.body?.package || "").trim().toLowerCase();
  const grade = Number(req.body?.grade);

  if(pkg === "baza") pkg = "base";
  if(pkg === "standard") pkg = "standart";

  if(!["pending","base","standart","premium"].includes(pkg)){
    return res.status(400).json({ok:false,error:"bad_package"});
  }

  if(![5,6,7,8,9,10,11].includes(grade)){
    return res.status(400).json({ok:false,error:"bad_grade"});
  }

  if(pkg !== "pending" && !isValidPackageGrade(pkg, grade)){
    return res.status(400).json({
      ok:false,
      error:"bad_package_grade_combo"
    });
  }

  const user = db.users.find(x => String(x.studentId || "") === studentId);
  if(!user){
    return res.status(404).json({ok:false,error:"student_not_found"});
  }

  user.package = pkg;
  user.grade = grade;

  writeDB(db);
  return res.json({
    ok:true,
    allowedGrades: getAllowedGradesByPackage(pkg, grade)
  });
});

app.get("/api/admin/student/:studentId", requireAdmin, (req, res) => {
  const sid = String(req.params.studentId || "");
  const db = readDB();
  const u = (db.users || []).find((x) => String(x.studentId) === sid);

  if (!u) {
    return res.status(404).json({ ok: false, error: "not_found" });
  }

  const pkg = String(u.package || "pending").toLowerCase();
  const grade = Number(u.grade || 5);

  res.json({
    ok: true,
    student: {
      studentId: u.studentId,
      fullName: u.fullName,
      phone: u.phone,
      email: u.email,
      package: pkg,
      grade,
      allowedGrades: getAllowedGradesByPackage(pkg, grade)
    },
  });
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
app.post("/api/admin/upload", requireAdmin, uploadAdmin.single("file"), (req, res) => {
  try {
    const grade = normalizeGrade(req.body.grade);
    const subject = normalizeSubject(grade, req.body.subject);
    const block = Number(req.body.blockNumber);
    const type = String(req.body.type || "").toLowerCase(); // video|audio|doc

   if (!grade || !subject || !safeBlockNumber(block, grade, subject)) {
  return res.status(400).json({ ok: false, error: "bad_grade_subject_or_block" });
}

    const db = readDB();

    db.materials = db.materials || {};
    db.materials[grade] = db.materials[grade] || {};
    db.materials[grade][subject] = db.materials[grade][subject] || {};
    db.materials[grade][subject][String(block)] =
      db.materials[grade][subject][String(block)] || {
        videos: [],
        audios: [],
        docs: [],
        studentUploads: []
      };

    const relUrl = `/uploads/${grade}/${subject}/block${block}/${req.file.filename}`;
    const item = {
      url: relUrl,
      name: req.file.originalname,
      createdAt: nowISO()
    };

    if (type === "video") {
      db.materials[grade][subject][String(block)].videos.push(item);
    } else if (type === "audio") {
      db.materials[grade][subject][String(block)].audios.push(item);
    } else {
      db.materials[grade][subject][String(block)].docs.push(item);
    }

    writeDB(db);

    res.json({
      ok: true,
      grade,
      subject,
      block: String(block),
      item
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Student upload homework
app.post("/api/student/upload", requireStudent, uploadStudent.single("file"), (req, res) => {
  try {
    const grade = normalizeGrade(req.body.grade);
    const subject = normalizeSubject(grade, req.body.subject);
    const block = Number(req.body.blockNumber);
    const studentId = String(req.session?.user?.studentId || "");

   if (!grade || !subject || !safeBlockNumber(block, grade, subject) || !studentId) {
  return res.status(400).json({ ok: false, error: "bad_input" });
} 

    const db = readDB();

    db.materials[grade] = db.materials[grade] || {};
    db.materials[grade][subject] = db.materials[grade][subject] || {};
    db.materials[grade][subject][String(block)] =
      db.materials[grade][subject][String(block)] || {
        videos: [],
        audios: [],
        docs: [],
        studentUploads: []
      };

    const relUrl = `/student_uploads/${grade}/${subject}/block${block}/${studentId}/${req.file.filename}`;
    const item = {
      url: relUrl,
      name: req.file.originalname,
      studentId,
      createdAt: nowISO(),
      status: "uploaded",
    };

    db.materials[grade][subject][String(block)].studentUploads.push(item);
    db.progress = db.progress || {};
    db.progress[studentId] = db.progress[studentId] || {};
    db.progress[studentId][grade] = db.progress[studentId][grade] || {};
    db.progress[studentId][grade][subject] = db.progress[studentId][grade][subject] || {};
    db.progress[studentId][grade][subject][String(block)] =
      db.progress[studentId][grade][subject][String(block)] || {
        grade: null,
        status: "none",
        feedbackText: "",
        feedbackFileUrl: "",
        updatedAt: nowISO(),
      };

    db.progress[studentId][grade][subject][String(block)].status = "uploaded";
    db.progress[studentId][grade][subject][String(block)].updatedAt = nowISO();

    pushNotif(db, studentId, "upload", `(${grade} сынып, ${subject}) Блок ${block}: тапсырма жүктелді ✅`);

    writeDB(db);
    res.json({ ok: true, grade, subject, block: String(block), item });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Avatar upload
app.post("/api/avatar/upload", requireStudent, uploadAvatar.single("avatar"), (req, res) => {
  const studentId = String(req.session?.user?.studentId || "");

  if(!studentId || !req.file){
    return res.status(400).json({ ok:false, error:"bad_input" });
  }

  const db = readDB();
  const user = db.users.find(u => String(u.studentId || "") === studentId);

  if(!user){
    return res.status(404).json({ ok:false, error:"student_not_found" });
  }

  user.avatar = "/uploads/avatars/" + req.file.filename;
  writeDB(db);

  // session-ды да жаңартып қоямыз
  if(req.session?.user){
    req.session.user.avatar = user.avatar;
  }

  return res.json({
    ok:true,
    url:user.avatar
  });
});

// Get block materials
app.get("/api/materials", async (req, res) => {
  try {
    const { grade, subject, blockNumber } = req.query;

    const r = await fetch(
  `${SUPABASE_URL}/rest/v1/materials?select=*&grade=eq.${grade}&subject=eq.${subject}&block=eq.${blockNumber}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const data = await r.json();

    const videos = data.filter(x => x.type === "video");
    const docs = data.filter(x => x.type === "doc");
    const audios = data.filter(x => x.type === "audio");

    res.json({
      videos,
      docs,
      audios,
      studentUploads: []
    });

  } catch (e) {
    console.error(e);
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
app.get("/api/progress/get", requireAuth, (req, res) => {
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

  const db = readDB();
  db.progress = db.progress || {};
  db.progress[studentId] = db.progress[studentId] || {};
  db.progress[studentId][course] = db.progress[studentId][course] || {};
  db.progress[studentId][course][grade] = db.progress[studentId][course][grade] || {};
  db.progress[studentId][course][grade][subject] =
    db.progress[studentId][course][grade][subject] || {};

  const subjProg = db.progress[studentId][course][grade][subject];

  const gradesMap = {};
  const feedbackMap = {};

  for (const [block, item] of Object.entries(subjProg || {})) {
    const g = Number(item?.grade);
    if (Number.isFinite(g) && g > 0) gradesMap[String(block)] = g;

    const fb = String(item?.feedbackText || "");
    if (fb.trim()) {
      feedbackMap[String(block)] = { text: fb, updatedAt: item?.updatedAt || "" };
    }
  }

  return res.json({
    ok: true,
    course,
    grade,
    subject,
    data: subjProg,
    gradesMap,
    feedbackMap,
  });
});

app.get("/api/progress/summary", requireAuth, (req, res) => {
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

  const db = readDB();
  db.progress = db.progress || {};

  const all = db.progress?.[studentId]?.[course] || {};
  const flat = {};

  for (const [grade, subjects] of Object.entries(all)) {
    for (const [subject, blocks] of Object.entries(subjects || {})) {
      for (const [block, item] of Object.entries(blocks || {})) {
        const key = `${grade}_${subject}_${block}`;
        flat[key] = {
          grade: Number(item?.grade ?? 0),
          status: String(item?.status || ""),
          feedbackText: String(item?.feedbackText || ""),
          feedbackFileUrl: String(item?.feedbackFileUrl || ""),
          updatedAt: item?.updatedAt || "",
          schoolGrade: Number(grade),
          subject,
          blockNumber: Number(block),
          course
        };
      }
    }
  }

  return res.json({ ok: true, course, data: flat });
});

// ✅ Admin sets grade/status/feedback (lessonNumber OR lesson) + auto graded status

app.post("/api/progress/set", requireAdmin, (req, res) => {
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

  const db = readDB();

  db.progress = db.progress || {};
  db.progress[studentId] = db.progress[studentId] || {};
  db.progress[studentId][course] = db.progress[studentId][course] || {};
  db.progress[studentId][course][grade] = db.progress[studentId][course][grade] || {};
  db.progress[studentId][course][grade][subject] =
    db.progress[studentId][course][grade][subject] || {};

  const prev = {
    ...(db.progress[studentId][course][grade][subject][String(block)] || {})
  };

  db.progress[studentId][course][grade][subject][String(block)] =
    db.progress[studentId][course][grade][subject][String(block)] || {
      grade: null,
      status: "none",
      feedbackText: "",
      feedbackFileUrl: "",
      updatedAt: nowISO(),
    };

  const item = db.progress[studentId][course][grade][subject][String(block)];

  let gradeSet = false;
  if (gradeRaw !== undefined && gradeRaw !== null && gradeRaw !== "") {
    const g = Number(gradeRaw);
    if (!Number.isFinite(g) || g < 0 || g > 100) {
      return res.status(400).json({ ok: false, error: "bad_grade" });
    }
    item.grade = g;
    gradeSet = true;
  }

  if (statusRaw !== undefined && statusRaw !== null && statusRaw !== "") {
    item.status = String(statusRaw).toLowerCase();
  }

  if (gradeSet) item.status = "graded";

  if (feedbackText !== undefined) item.feedbackText = String(feedbackText || "");
  if (feedbackFileUrl !== undefined) item.feedbackFileUrl = String(feedbackFileUrl || "");

  item.updatedAt = nowISO();

  const oldGrade = Number(prev?.grade ?? 0);
  const newGrade = Number(item?.grade ?? 0);

  const oldFeedback = String(prev?.feedbackText || "").trim();
  const newFeedback = String(item?.feedbackText || "").trim();

  if (newFeedback && newFeedback !== oldFeedback) {
    pushNotif(
      db,
      studentId,
      "feedback",
      `[${course}] (${grade} сынып, ${subject}) Блок ${block}: мұғалім пікір қалдырды 💬`
    );
  }

  if (Number.isFinite(newGrade) && newGrade > 0 && newGrade !== oldGrade) {
    pushNotif(
      db,
      studentId,
      "review",
      `[${course}] (${grade} сынып, ${subject}) Блок ${block}: баға қойылды 🏅`
    );
  }

  writeDB(db);
  return res.json({ ok: true });
});

// ================= STREAK (SERVER) =================
const STREAK_FILE = path.join(__dirname, "data", "streak_days.json");

function loadStreakDB(){
  try{
    if(!fs.existsSync(STREAK_FILE)) return {};
    const txt = fs.readFileSync(STREAK_FILE, "utf8");
    const j = JSON.parse(txt || "{}");
    return (j && typeof j === "object") ? j : {};
  }catch{
    return {};
  }
}

function saveStreakDB(db){
  try{
    fs.mkdirSync(path.dirname(STREAK_FILE), { recursive: true });
    fs.writeFileSync(STREAK_FILE, JSON.stringify(db, null, 2), "utf8");
  }catch(e){
    console.error("saveStreakDB error", e);
  }
}

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
app.post("/api/streak/ping", (req,res)=>{
  try{
    const studentId = String(req.body?.studentId || "").trim();
    const dayKey = String(req.body?.dayKey || "").trim(); // "YYYY-MM-DD"

    if(!studentId || !dayKey){
      return res.status(400).json({ ok:false, error:"bad_input" });
    }

    const db = loadStreakDB();
    const rec = db[studentId] || { days: [] };
    const days = Array.isArray(rec.days) ? rec.days : [];

    if(!days.includes(dayKey)){
      days.push(dayKey);
    }

    // 180 күннен асырмай қояйық
    days.sort(); // YYYY-MM-DD болғандықтан дұрыс сортталады
    const trimmed = days.slice(-180);

    db[studentId] = { days: trimmed, updatedAt: new Date().toISOString() };
    saveStreakDB(db);

    const streak = calcStreakFromDays(trimmed, dayKey);

    return res.json({ ok:true, studentId, dayKey, streak, days: trimmed });
  }catch(e){
    console.error("streak/ping error", e);
    return res.status(500).json({ ok:false, error:"server_error" });
  }
});

// GET /api/streak/get?studentId=...&dayKey=YYYY-MM-DD
app.get("/api/streak/get", (req,res)=>{
  try{
    const studentId = String(req.query?.studentId || "").trim();
    const dayKey = String(req.query?.dayKey || "").trim();

    if(!studentId || !dayKey){
      return res.status(400).json({ ok:false, error:"bad_input" });
    }

    const db = loadStreakDB();
    const rec = db[studentId] || { days: [] };
    const days = Array.isArray(rec.days) ? rec.days : [];
    const streak = calcStreakFromDays(days, dayKey);

    return res.json({ ok:true, studentId, dayKey, streak, days });
  }catch(e){
    console.error("streak/get error", e);
    return res.status(500).json({ ok:false, error:"server_error" });
  }
});

// ===================== NOTIFICATIONS =====================
app.get("/api/notifications", requireAuth, (req, res) => {
  const sessionUser = req.session?.user || null;
  if (!sessionUser) return res.status(401).json({ ok: false, error: "unauthorized" });

  const requestedStudentId = String(req.query.studentId || "");
  const sessionStudentId = String(sessionUser.studentId || "");

  // admin болмаса — тек өз notification-ын ғана көре алады
  const studentId =
    sessionUser.role === "admin"
      ? requestedStudentId
      : sessionStudentId;

  if (!studentId) {
    return res.status(400).json({ ok: false, error: "missing_studentId" });
  }

  const db = readDB();
  const list = db.notifications?.[studentId] || [];
  res.json({ ok: true, list: list.slice(0, 30) });
});

app.post("/api/notifications/mark-read", requireAuth, (req, res) => {
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

  const db = readDB();
  const list = db.notifications?.[studentId] || [];
  const n = list.find((x) => x.id === id);
  if (n) n.read = true;

  writeDB(db);
  res.json({ ok: true });
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
