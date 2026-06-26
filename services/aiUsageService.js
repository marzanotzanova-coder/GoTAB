const DAILY_LIMIT = 3;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function getUsage(studentId, lessonId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const date = todayStr();
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_daily_usage?select=generation_count&student_id=eq.${encodeURIComponent(studentId)}&lesson_id=eq.${encodeURIComponent(lessonId)}&date=eq.${encodeURIComponent(date)}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json().catch(() => []);
    const count = Array.isArray(rows) && rows[0] ? Number(rows[0].generation_count) : 0;
    return { count, remaining: Math.max(0, DAILY_LIMIT - count), date };
  } catch (e) {
    console.error("aiUsage getUsage error:", e);
    return { count: 0, remaining: DAILY_LIMIT, date };
  }
}

async function incrementUsage(studentId, lessonId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const date = todayStr();

  const checkR = await fetch(
    `${SUPABASE_URL}/rest/v1/ai_daily_usage?select=generation_count&student_id=eq.${encodeURIComponent(studentId)}&lesson_id=eq.${encodeURIComponent(lessonId)}&date=eq.${encodeURIComponent(date)}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await checkR.json().catch(() => []);
  const existing = Array.isArray(rows) ? rows[0] : null;
  const prevCount = existing ? Number(existing.generation_count) : 0;
  const newCount = prevCount + 1;

  if (existing) {
    await fetch(
      `${SUPABASE_URL}/rest/v1/ai_daily_usage?student_id=eq.${encodeURIComponent(studentId)}&lesson_id=eq.${encodeURIComponent(lessonId)}&date=eq.${encodeURIComponent(date)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ generation_count: newCount })
      }
    );
  } else {
    await fetch(`${SUPABASE_URL}/rest/v1/ai_daily_usage`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify([{ student_id: studentId, lesson_id: lessonId, date, generation_count: 1 }])
    });
  }

  return { count: newCount, remaining: Math.max(0, DAILY_LIMIT - newCount) };
}

module.exports = { getUsage, incrementUsage, DAILY_LIMIT };
