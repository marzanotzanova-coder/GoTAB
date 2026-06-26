const TOPIC_RULES = [
  [/анықталу облыс/i,            "Анықталу облысы"],
  [/мәндер жиын/i,               "Мәндер жиыны"],
  [/кері функция/i,              "Кері функция"],
  [/√|түбір/i,                   "Түбірлі функция"],
  [/сызықтық|kx\s*[\+\-]|y\s*=\s*kx/i, "Сызықтық функция"],
  [/квадраттық|x\^2|x²/i,        "Квадраттық функция"],
  [/тригоном|sin\(|cos\(|tan\(|ctg\(/i, "Тригонометриялық функция"],
  [/логарифм|\blog\b/i,           "Логарифмдік функция"],
  [/монотон|өсу|кему/i,           "Монотондылық"],
  [/жұп функция|тақ функция|паритет/i, "Функция паритеті"],
  [/максим|миним|экстремум/i,     "Экстремум"],
  [/graph|график/i,               "График"],
];

function inferTopic(text) {
  for (const [re, topic] of TOPIC_RULES) {
    if (re.test(text)) return topic;
  }
  return "Жалпы тақырып";
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Parse raw quiz text into structured question objects.
 * Returns { ok: bool, questions: [...], errors: [...] }
 *
 * Format:
 *   <question>Question text
 *   <topic>Optional topic
 *   <answer>Correct answer text
 *   <variant>Wrong option
 *   <variant>Wrong option
 */
function parseQuiz(rawText) {
  if (!rawText || !rawText.trim()) {
    return { ok: false, questions: [], errors: ["Мәтін бос."] };
  }

  const errors   = [];
  const questions = [];

  const blocks = rawText.split(/^<question>/im).map(b => b.trim()).filter(Boolean);

  if (blocks.length === 0) {
    return { ok: false, questions: [], errors: ["<question> тегі табылмады."] };
  }

  for (let bi = 0; bi < blocks.length; bi++) {
    const qNum = bi + 1;
    const lines = blocks[bi].split("\n").map(l => l.trim()).filter(Boolean);

    const questionParts = [];
    let topic   = null;
    let correct = null;
    const variants = [];

    for (const line of lines) {
      const m = line.match(/^<(topic|answer|variant)>(.*)/i);
      if (!m) { questionParts.push(line); continue; }
      const tag = m[1].toLowerCase();
      const val = m[2].trim();
      if      (tag === "topic"   && val) topic = val;
      else if (tag === "answer"  && val) correct = val;
      else if (tag === "variant" && val) variants.push(val);
    }

    const questionText = questionParts.join(" ").trim();

    if (!questionText) { errors.push(`Сұрақ №${qNum}: мәтін жоқ.`);                     continue; }
    if (!correct)      { errors.push(`Сұрақ №${qNum}: <answer> тегі жоқ.`);             continue; }
    if (!variants.length){ errors.push(`Сұрақ №${qNum}: кем дегенде 1 <variant> керек.`); continue; }

    if (!topic) topic = inferTopic(questionText);

    const options = [correct, ...variants].filter((v, i, a) => a.indexOf(v) === i);

    if (options.length < 2) { errors.push(`Сұрақ №${qNum}: кем дегенде 2 нұсқа керек.`); continue; }

    questions.push({ question: questionText, topic, correct, options });
  }

  if (questions.length === 0) {
    return { ok: false, questions: [], errors: errors.length ? errors : ["Жарамды сұрақтар табылмады."] };
  }

  return { ok: true, questions, errors };
}

/**
 * Return student-safe version of questions:
 * options are shuffled, correct answer is NOT included.
 */
function questionsForStudent(parsedQuestions) {
  return parsedQuestions.map((q, idx) => ({
    idx,
    question: q.question,
    options: shuffle(q.options),
  }));
}

module.exports = { parseQuiz, questionsForStudent, inferTopic };
