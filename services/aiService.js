const { GoogleGenerativeAI } = require("@google/generative-ai");

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
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY is not configured");

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

  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash", systemInstruction });
  const result = await model.generateContent(userMsg);
  const text = result.response.text().trim();
  if (!text) throw new Error("Gemini returned empty response");

  return { text, title: config.titleKz };
}

module.exports = { generateProblems, ALLOWED_PROMPT_TYPES };
