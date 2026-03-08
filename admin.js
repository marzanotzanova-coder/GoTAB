document.addEventListener("DOMContentLoaded", function() {
  const videoUpload = document.getElementById("video-upload");
  const audioUpload = document.getElementById("audio-upload");
  const docUpload = document.getElementById("doc-upload");
  const saveBtn = document.getElementById("save-btn");
  const uploadedContent = document.getElementById("uploaded-content");

  saveBtn.addEventListener("click", function() {
    uploadedContent.innerHTML = "";

    // Видеолар
    if(videoUpload.files.length > 0){
      const videoHeader = document.createElement("h3");
      videoHeader.textContent = "Жүктелген видеолар:";
      uploadedContent.appendChild(videoHeader);

      Array.from(videoUpload.files).forEach(file => {
        const video = document.createElement("video");
        video.controls = true;
        video.style.width = "100%";
        video.style.marginBottom = "10px";
        video.src = URL.createObjectURL(file);
        uploadedContent.appendChild(video);
      });
    }

    // Аудиолар
    if(audioUpload.files.length > 0){
      const audioHeader = document.createElement("h3");
      audioHeader.textContent = "Жүктелген аудиолар:";
      uploadedContent.appendChild(audioHeader);

      Array.from(audioUpload.files).forEach(file => {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.style.display = "block";
        audio.style.marginBottom = "10px";
        audio.src = URL.createObjectURL(file);
        uploadedContent.appendChild(audio);
      });
    }

    // Документтер
    if(docUpload.files.length > 0){
      const docHeader = document.createElement("h3");
      docHeader.textContent = "Жүктелген документтер:";
      uploadedContent.appendChild(docHeader);

      Array.from(docUpload.files).forEach(file => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(file);
        link.textContent = file.name;
        link.target = "_blank";
        link.style.display = "block";
        uploadedContent.appendChild(link);
      });
    }

    alert("Барлық файлдар жүктелді!");
  });
});