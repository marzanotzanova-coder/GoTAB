const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.onsubmit = e => {
    e.preventDefault();
    window.location.href = "my-courses.html";
  };
}

const registerForm = document.getElementById("registerForm");
if (registerForm) {
  registerForm.onsubmit = e => {
    e.preventDefault();
    window.location.href = "my-courses.html";
  };
}