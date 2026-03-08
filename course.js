const userCourse = localStorage.getItem("userCourse") || "base";
const lessons = JSON.parse(localStorage.getItem("lessons")) || {};
const list = document.getElementById("lessonList");

if (!lessons[userCourse]) {
  list.innerHTML = "<p>Сабақтар әлі қосылмаған</p>";
} else {
  lessons[userCourse].forEach(lesson => {
    const div = document.createElement("div");

    // Барлық видеолар
    const videoHTML = lesson.videos.map(v => `
  <video controls width="100%">
    <source src="${v}" type="video/mp4">
    Браузеріңіз видеоны қолдамайды.
  </video>
`).join("");
    const audioHTML = lesson.audios.map(a => `<audio controls src="${a}"></audio>`).join("");
    const docHTML = lesson.docs.map(d => `<a href="${d}" target="_blank">📄 Документ ашу</a>`).join("<br>");

    div.innerHTML = `
      <h3>${lesson.title}</h3>
      ${videoHTML}
      ${audioHTML}
      ${docHTML}
      <hr>
    `;

    list.appendChild(div);
  });
}