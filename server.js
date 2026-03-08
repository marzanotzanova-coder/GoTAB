process.env.TZ = "Asia/Almaty";

// server.js (GoTAB LMS Core - WORKING FULL)
const express = require("express");
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
  fullName: st.fullName || "Оқушы",
  phone: st.phone || "",
  email: st.email || "",
  avatar: st.avatar || ""
};

  return res.json({ ok:true, user: req.session.user });
}
  return res.status(400).json({ ok:false, error:"bad_role" });
s});

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
    users: [], // {studentId, fullName, phone, email, password, package}
    // course keys: base | standart | premium
    materials: { base: {}, standart: {}, premium: {} }, // materials[course][lesson] = {videos, audios, docs, studentUploads}
    progress: {}, // progress[studentId][course][lesson] = {grade,status,feedbackText,feedbackFileUrl,updatedAt}
    notifications: {}, // notifications[studentId] = [{id,type,text,createdAt,read}]
    streak: {}, // streak[studentId] = { lastVisitDate, current, best, totalLogins }
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
    if (!db.materials) db.materials = { base: {}, standart: {}, premium: {} };
    if (!db.materials.base) db.materials.base = {};
    if (!db.materials.standart) db.materials.standart = {};
    if (!db.materials.premium) db.materials.premium = {};

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

function safeLessonNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) && x >= 1 && x <= 30;
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
  studentId,
  package: user.package,
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
app.get("/api/admin/student/:studentId", (req, res) => {
  const sid = String(req.params.studentId || "");
  const db = readDB();
  const u = (db.users || []).find((x) => String(x.studentId) === sid);
  if (!u) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({
    ok: true,
    student: {
      studentId: u.studentId,
      fullName: u.fullName,
      phone: u.phone,
      email: u.email,
      package: u.package || "baza",
    },
  });
});

// ===================== MULTER STORAGE =====================
// ADMIN uploads
const adminStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const course = normalizeCourse(req.body.course);
    const lesson = Number(req.body.lessonNumber);
    if (!safeCourse(course) || !safeLessonNumber(lesson)) return cb(new Error("Bad course/lesson"));

    const dest = path.join(__dirname, "uploads", course, "lesson" + lesson);
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
    const course = normalizeCourse(req.body.course);
    const lesson = Number(req.body.lessonNumber);
    const studentId = String(req.session?.user?.studentId || "");
    if (!safeCourse(course) || !safeLessonNumber(lesson) || !studentId) return cb(new Error("Bad input"));

    const dest = path.join(__dirname, "student_uploads", course, "lesson" + lesson, studentId);
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
    const course = normalizeCourse(req.body.course);
    const lesson = Number(req.body.lessonNumber);
    const type = String(req.body.type || "").toLowerCase(); // video|audio|doc

    if (!safeCourse(course) || !safeLessonNumber(lesson)) {
      return res.status(400).json({ ok: false, error: "bad_course_or_lesson" });
    }

    const db = readDB();
    db.materials = db.materials || { base: {}, standart: {}, premium: {} };
    db.materials[course] = db.materials[course] || {};
    db.materials[course][String(lesson)] =
      db.materials[course][String(lesson)] || { videos: [], audios: [], docs: [], studentUploads: [] };

    const relUrl = `/uploads/${course}/lesson${lesson}/${req.file.filename}`;
    const item = { url: relUrl, name: req.file.originalname, createdAt: nowISO() };

    if (type === "video") db.materials[course][String(lesson)].videos.push(item);
    else if (type === "audio") db.materials[course][String(lesson)].audios.push(item);
    else db.materials[course][String(lesson)].docs.push(item);

    writeDB(db);
    res.json({ ok: true, course, lesson: String(lesson), item });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Student upload homework
app.post("/api/student/upload", requireStudent, uploadStudent.single("file"), (req, res) => {
  try {
    const course = normalizeCourse(req.body.course);
    const lesson = Number(req.body.lessonNumber);
    const studentId = String(req.session?.user?.studentId || "");

    if (!safeCourse(course) || !safeLessonNumber(lesson) || !studentId) {
      return res.status(400).json({ ok: false, error: "bad_input" });
    }

    const db = readDB();

    // materials
    db.materials[course] = db.materials[course] || {};
    db.materials[course][String(lesson)] =
      db.materials[course][String(lesson)] || { videos: [], audios: [], docs: [], studentUploads: [] };

    const relUrl = `/student_uploads/${course}/lesson${lesson}/${studentId}/${req.file.filename}`;
    const item = {
      url: relUrl,
      name: req.file.originalname,
      studentId,
      createdAt: nowISO(),
      status: "uploaded",
    };

    db.materials[course][String(lesson)].studentUploads.push(item);

    // progress pipeline
    db.progress = db.progress || {};
    db.progress[studentId] = db.progress[studentId] || {};
    db.progress[studentId][course] = db.progress[studentId][course] || {};
    db.progress[studentId][course][String(lesson)] = db.progress[studentId][course][String(lesson)] || {
      grade: null,
      status: "none",
      feedbackText: "",
      feedbackFileUrl: "",
      updatedAt: nowISO(),
    };

    db.progress[studentId][course][String(lesson)].status = "uploaded";
    db.progress[studentId][course][String(lesson)].updatedAt = nowISO();

    pushNotif(db, studentId, "upload", `(${course}) Сабақ ${lesson}: тапсырма жүктелді ✅`);

    writeDB(db);
    res.json({ ok: true, course, lesson: String(lesson), item });
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

// Get lesson materials
app.get("/api/materials", (req, res) => {
  const course = normalizeCourse(req.query.course);
  const lesson = Number(req.query.lessonNumber);

  if (!safeCourse(course) || !safeLessonNumber(lesson)) {
    return res.json({ videos: [], audios: [], docs: [], studentUploads: [] });
  }

  const db = readDB();
  const data =
    (db.materials && db.materials[course] && db.materials[course][String(lesson)]) || {
      videos: [],
      audios: [],
      docs: [],
      studentUploads: [],
    };

  res.json(data);
});

// ===================== PROGRESS PIPELINE =====================
// ✅ Get progress (per student, per course) + gradesMap + feedbackMap
app.get("/api/progress/get", requireAuth, (req, res) => {
  const sessionUser = req.session?.user || null;
  const requestedStudentId = String(req.query.studentId || "");
  const course = normalizeCourse(req.query.course);

  const studentId =
    sessionUser?.role === "admin"
      ? requestedStudentId
      : String(sessionUser?.studentId || "");

  if (!studentId || !safeCourse(course)) {
    return res.status(400).json({ ok: false, error: "bad_input" });
  }

  const db = readDB();
  db.progress = db.progress || {};
  db.progress[studentId] = db.progress[studentId] || {};
  db.progress[studentId][course] = db.progress[studentId][course] || {};

  const courseProg = db.progress[studentId][course];

  const gradesMap = {};
  const feedbackMap = {};

  for (const [lesson, item] of Object.entries(courseProg || {})) {
    const g = Number(item?.grade);
    if (Number.isFinite(g) && g > 0) gradesMap[String(lesson)] = g;

    const fb = String(item?.feedbackText || "");
    if (fb.trim()) {
      feedbackMap[String(lesson)] = { text: fb, updatedAt: item?.updatedAt || "" };
    }
  }

  return res.json({
    ok: true,
    course,
    data: courseProg,
    gradesMap,
    feedbackMap,
  });
});

// ✅ Admin sets grade/status/feedback (lessonNumber OR lesson) + auto graded status

app.post("/api/progress/set", requireAdmin, (req, res) => {
  const body = req.body || {};

  const studentId = String(body.studentId || "");
  const c = normalizeCourse(body.course);

  const lessonRaw = (body.lessonNumber !== undefined) ? body.lessonNumber : body.lesson;
  const lesson = Number(lessonRaw);
  

  const gradeRaw = body.grade;
  const statusRaw = body.status;
  const feedbackText = body.feedbackText;
  const feedbackFileUrl = body.feedbackFileUrl;


  if (!studentId || !safeCourse(c) || !safeLessonNumber(lesson)) {
    return res.status(400).json({ ok: false, error: "bad_input" });
  }

  const db = readDB();

const prev = { ...(db.progress?.[studentId]?.[c]?.[String(lesson)] || {}) };

db.progress = db.progress || {};
db.progress[studentId] = db.progress[studentId] || {};
db.progress[studentId][c] = db.progress[studentId][c] || {};
db.progress[studentId][c][String(lesson)] = db.progress[studentId][c][String(lesson)] || {
  grade: null,
  status: "none",
  feedbackText: "",
  feedbackFileUrl: "",
  updatedAt: nowISO(),
};

const item = db.progress[studentId][c][String(lesson)];
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

  // grade қойылса — status автомат graded
  if (gradeSet) item.status = "graded";

  if (feedbackText !== undefined) item.feedbackText = String(feedbackText || "");
  if (feedbackFileUrl !== undefined) item.feedbackFileUrl = String(feedbackFileUrl || "");

  item.updatedAt = nowISO();

 const oldGrade = Number(prev?.grade ?? 0);
const newGrade = Number(item?.grade ?? 0);

const oldFeedback = String(prev?.feedbackText || "").trim();
const newFeedback = String(item?.feedbackText || "").trim();

if(newFeedback && newFeedback !== oldFeedback){
  pushNotif(
    db,
    studentId,
    "feedback",
    `(${c}) Сабақ ${lesson}: мұғалім пікір қалдырды 💬`
  );
}

if(Number.isFinite(newGrade) && newGrade > 0 && newGrade !== oldGrade){
  pushNotif(
    db,
    studentId,
    "review",
    `(${c}) Сабақ ${lesson}: баға қойылды 🏅`
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
