document.addEventListener("DOMContentLoaded", function () {

  const loginBtn = document.getElementById("login-btn");
  const registerBtn = document.getElementById("register-btn");

  // АДМИН ДЕРЕКТЕРІ
  const ADMIN_PHONE = "77055894347";
  const ADMIN_EMAIL = "admin@gotab.kz";

  loginBtn.addEventListener("click", function () {
    const phone = document.getElementById("phone").value.trim();
    const email = document.getElementById("email").value.trim();

    if (!phone || !email) {
      alert("Телефон номер мен Email енгізіңіз");
      return;
    }

    // ✅ ЕГЕР АДМИН БОЛСА
    if (phone === ADMIN_PHONE && email === ADMIN_EMAIL) {
      window.location.href = "admin.html";
      return;
    }

    // ❗ ОҚУШЫ ҮШІН — SMS КОД
    const generatedCode = Math.floor(1000 + Math.random() * 9000);
    alert("Тест SMS код: " + generatedCode);

    const smsBlock = document.getElementById("sms-block");
    smsBlock.style.display = "block";

    const verifyBtn = document.getElementById("verify-btn");
    const smsInput = document.getElementById("sms-code");

    verifyBtn.onclick = function () {
      if (smsInput.value.trim() === String(generatedCode)) {
        window.location.href = "course.html";
      } else {
        alert("Код қате");
      }
    };
  });

  // РЕГИСТРАЦИЯ
  registerBtn.addEventListener("click", function () {
    window.location.href = "register.html";
  });

});