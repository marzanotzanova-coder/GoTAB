const { GoogleGenerativeAI } = require("@google/generative-ai");

const MODEL_NAME = "gemini-2.0-flash";

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

async function generateProblems({ grade, subject, lessonId, todayTopics, promptType }) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  console.log(`[aiService] generateProblems | GEMINI_API_KEY exists=${!!GEMINI_KEY} grade=${grade} subject=${subject} lessonId=${lessonId} promptType=${promptType}`);

  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY is not configured on this server");

  const config = PROMPT_CONFIGS[promptType];
  if (!config) throw new Error("Invalid prompt type: " + promptType);

  const systemInstruction = [
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

  console.log(`[aiService] calling Gemini model=${MODEL_NAME} msgLength=${userMsg.length}`);

  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({ model: MODEL_NAME, systemInstruction });

  let result;
  try {
    result = await model.generateContent(userMsg);
  } catch (e) {
    console.error("[aiService] Gemini generateContent threw:", e.message, e?.status, e?.statusText);
    throw e;
  }

  let text;
  try {
    text = result.response.text().trim();
  } catch (e) {
    // response.text() throws when the response was blocked by safety filters
    console.error("[aiService] response.text() threw (likely safety filter):", e.message);
    const candidate = result?.response?.candidates?.[0];
    console.error("[aiService] finishReason:", candidate?.finishReason, "safetyRatings:", JSON.stringify(candidate?.safetyRatings));
    throw new Error("Gemini blocked the response (safety filter). finishReason: " + (candidate?.finishReason || "unknown"));
  }

  console.log(`[aiService] Gemini response received | textLength=${text.length}`);

  if (!text) throw new Error("Gemini returned an empty response");

  return { text, title: config.titleKz };
}

module.exports = { generateProblems, ALLOWED_PROMPT_TYPES };
