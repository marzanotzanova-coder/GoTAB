const OpenAI = require("openai");

const PROMPT_CONFIGS = {
  extra_practice: {
    titleKz: "📘 Жаттығу есептері",
    styleKz: "орташа қиын, жаттығу"
  },
  hard_practice: {
    titleKz: "🔥 Қиын есептер",
    styleKz: "қиын деңгей, тереңдетілген"
  },
  mixed_revision: {
    titleKz: "🧠 Аралас қайталау",
    styleKz: "аралас, өткен тақырыптарды қайталау"
  },
  exam_style: {
    titleKz: "🎯 Емтихан форматы",
    styleKz: "емтихан стилі, ресми"
  }
};

const ALLOWED_PROMPT_TYPES = Object.keys(PROMPT_CONFIGS);

// ── Model discovery ────────────────────────────────────────────────────────────
// Called once at startup; every subsequent call returns the cached promise.
let _modelPromise = null;

async function _discoverModel() {
  const key = process.env.OPENAI_API_KEY;
  const fallback = "gpt-4o";

  if (!key) {
    console.log(`[aiService] OPENAI_API_KEY not set — using fallback model: ${fallback}`);
    return fallback;
  }

  try {
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` }
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error(`[aiService] Models API returned ${r.status}: ${body.slice(0, 200)} — using fallback: ${fallback}`);
      return fallback;
    }

    const data = await r.json();
    const allIds = (data.data || []).map(m => m.id).sort();
    console.log(`[aiService] Total models available: ${allIds.length}`);

    const gpt5 = allIds.filter(id => /^gpt-5/i.test(id));
    console.log(`[aiService] GPT-5 models found: ${gpt5.length ? gpt5.join(", ") : "none"}`);

    // Priority: exact gpt-5 → any full (non-mini) gpt-5 → gpt-5 mini → first gpt-5
    const chosen =
      gpt5.find(id => id === "gpt-5") ||
      gpt5.find(id => id === "gpt-5-turbo") ||
      gpt5.find(id => !/mini/i.test(id)) ||
      gpt5.find(id => /mini/i.test(id)) ||
      gpt5[0];

    const model = chosen || fallback;
    console.log(`Using OpenAI model: ${model}`);
    return model;
  } catch (e) {
    console.error(`[aiService] Failed to fetch models list: ${e.message} — using fallback: ${fallback}`);
    return fallback;
  }
}

function resolveModel() {
  if (!_modelPromise) _modelPromise = _discoverModel();
  return _modelPromise;
}

// ── Main function ──────────────────────────────────────────────────────────────
async function generateProblems({ grade, subject, lessonId, todayTopics, promptType }) {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const MODEL_NAME = await resolveModel();

  console.log(`[aiService] generateProblems | OPENAI_API_KEY exists=${!!OPENAI_KEY} model=${MODEL_NAME} grade=${grade} subject=${subject} lessonId=${lessonId} promptType=${promptType}`);

  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is not configured on this server");

  const config = PROMPT_CONFIGS[promptType];
  if (!config) throw new Error("Invalid prompt type: " + promptType);

  const instructions = [
    "Сен GoTAB онлайн платформасының математика мұғалімісің.",
    "Тек қазақ тілінде жауап бер.",
    "Дәл 5 есеп жаз — не аз, не көп.",
    "Есептердің жауаптарын, шешімдерін, түсіндірмелерін БЕРМЕ.",
    "Форматы: нөмірленген тізім (1. 2. 3. 4. 5.).",
    "Болашақ сыныптардан есеп БЕРМЕ. Тек осы сыныпқа сай есеп жаз.",
    "Бірінші жолда тақырып атауын жаз.",
    "Екінші жолда қысқаша нұсқаулық (1 сөйлем) жаз.",
    "Одан кейін нөмірленген тізім."
  ].join(" ");

  const topicLine = todayTopics ? `Бүгін оқыған тақырыптар: "${todayTopics}".` : "";

  const userMsg = [
    `${grade}-сынып, ${subject} пәні.`,
    lessonId ? `${lessonId}.` : "",
    topicLine,
    `Стиль: ${config.styleKz}.`,
    "Дәл 5 есеп бер. Жауабын берме."
  ].filter(Boolean).join(" ");

  console.log(`[aiService] calling OpenAI model=${MODEL_NAME} msgLength=${userMsg.length}`);

  const client = new OpenAI({ apiKey: OPENAI_KEY });

  let response;
  try {
    response = await client.responses.create({
      model: MODEL_NAME,
      instructions,
      input: userMsg
    });
  } catch (e) {
    console.error("[aiService] OpenAI responses.create threw:");
    console.error("  message   :", e.message);
    console.error("  status    :", e?.status ?? "n/a");
    console.error("  openai_code:", e?.error?.code ?? "n/a");
    console.error("  error body:", JSON.stringify(e?.error ?? null));
    console.error("  stack     :", e.stack);
    try { console.error("  raw JSON  :", JSON.stringify(e)); } catch {}
    throw e;
  }

  const text = (response.output_text || "").trim();
  console.log(`[aiService] OpenAI response received | textLength=${text.length}`);

  if (!text) throw new Error("OpenAI returned an empty response");

  return { text, title: config.titleKz };
}

module.exports = { generateProblems, resolveModel, ALLOWED_PROMPT_TYPES };
