const texts = {
  kk: {
    title: "Оқу • Бағалау • Өсу",
    courses: "Менің курстарым"
  },
  ru: {
    title: "Обучение • Оценка • Рост",
    courses: "Мои курсы"
  }
};

const lang = localStorage.getItem("lang") || "kk";
localStorage.setItem("lang", lang);

const select = document.getElementById("langSelect");
if (select) {
  select.value = lang;
  select.onchange = e => {
    localStorage.setItem("lang", e.target.value);
    location.reload();
  };
}

const title = document.getElementById("titleText");
if (title) title.innerText = texts[lang].title;

const courses = document.getElementById("coursesTitle");
if (courses) courses.innerText = texts[lang].courses;