const DAILY_LIMIT = 3;

function getSupabaseCreds() {
  const url = process.env.SUPABASE_URL;
  // Service role key bypasses RLS — required when RLS is enabled on ai_daily_usage.
  // Set SUPABASE_SERVICE_KEY in Render env vars (different from the anon key).
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const keyType = process.env.SUPABASE_SERVICE_KEY ? "service_role" : "anon";
  return { url, key, keyType };
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function getUsage(studentId, lessonId) {
  const { url, key, keyType } = getSupabaseCreds();
  const date = todayStr();

  console.log(`[aiUsage] getUsage | student=${studentId} lesson=${lessonId} date=${date} keyType=${keyType}`);

  try {
    const endpoint = `${url}/rest/v1/ai_daily_usage?select=generation_count&student_id=eq.${encodeURIComponent(studentId)}&lesson_id=eq.${encodeURIComponent(lessonId)}&date=eq.${encodeURIComponent(date)}`;
    const r = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });

    const body = await r.text();
    console.log(`[aiUsage] getUsage response | status=${r.status} body=${body}`);

    if (!r.ok) {
      console.error(`[aiUsage] getUsage Supabase error | status=${r.status} body=${body}`);
      return { count: 0, remaining: DAILY_LIMIT, date };
    }

    const rows = JSON.parse(body);
    const count = Array.isArray(rows) && rows[0] ? Number(rows[0].generation_count) : 0;
    console.log(`[aiUsage] getUsage result | count=${count} remaining=${DAILY_LIMIT - count}`);
    return { count, remaining: Math.max(0, DAILY_LIMIT - count), date };
  } catch (e) {
    console.error("[aiUsage] getUsage exception:", e.message);
    return { count: 0, remaining: DAILY_LIMIT, date };
  }
}

async function incrementUsage(studentId, lessonId) {
  const { url, key, keyType } = getSupabaseCreds();
  const date = todayStr();

  console.log(`[aiUsage] incrementUsage | student=${studentId} lesson=${lessonId} date=${date} keyType=${keyType}`);

  // Check existing row
  const checkR = await fetch(
    `${url}/rest/v1/ai_daily_usage?select=generation_count&student_id=eq.${encodeURIComponent(studentId)}&lesson_id=eq.${encodeURIComponent(lessonId)}&date=eq.${encodeURIComponent(date)}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  const checkBody = await checkR.text();
  console.log(`[aiUsage] incrementUsage check | status=${checkR.status} body=${checkBody}`);

  if (!checkR.ok) {
    console.error(`[aiUsage] incrementUsage check failed | status=${checkR.status} body=${checkBody}`);
    return { count: 1, remaining: DAILY_LIMIT - 1 };
  }

  const rows = JSON.parse(checkBody);
  const existing = Array.isArray(rows) ? rows[0] : null;
  const prevCount = existing ? Number(existing.generation_count) : 0;
  const newCount = prevCount + 1;

  if (existing) {
    const patchR = await fetch(
      `${url}/rest/v1/ai_daily_usage?student_id=eq.${encodeURIComponent(studentId)}&lesson_id=eq.${encodeURIComponent(lessonId)}&date=eq.${encodeURIComponent(date)}`,
      {
        method: "PATCH",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ generation_count: newCount })
      }
    );
    const patchBody = await patchR.text();
    console.log(`[aiUsage] incrementUsage PATCH | status=${patchR.status} body=${patchBody}`);
    if (!patchR.ok) console.error(`[aiUsage] incrementUsage PATCH failed | status=${patchR.status} body=${patchBody}`);
  } else {
    const postR = await fetch(`${url}/rest/v1/ai_daily_usage`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify([{ student_id: studentId, lesson_id: lessonId, date, generation_count: 1 }])
    });
    const postBody = await postR.text();
    console.log(`[aiUsage] incrementUsage POST | status=${postR.status} body=${postBody}`);
    if (!postR.ok) console.error(`[aiUsage] incrementUsage POST failed | status=${postR.status} body=${postBody}`);
  }

  console.log(`[aiUsage] incrementUsage done | newCount=${newCount} remaining=${Math.max(0, DAILY_LIMIT - newCount)}`);
  return { count: newCount, remaining: Math.max(0, DAILY_LIMIT - newCount) };
}

module.exports = { getUsage, incrementUsage, DAILY_LIMIT };
