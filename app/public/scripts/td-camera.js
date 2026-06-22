// ══════════════════════════ CAMERA ══════════════════════════
let cameraRotation = 0;
let cameraRafId = null;

function drawCameraFrame() {
  const video  = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  if (!canvas || !video || !video.srcObject) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) { cameraRafId = requestAnimationFrame(drawCameraFrame); return; }
  const swapped = cameraRotation === 90 || cameraRotation === 270;
  canvas.width  = swapped ? vh : vw;
  canvas.height = swapped ? vw : vh;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(cameraRotation * Math.PI / 180);
  ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
  ctx.restore();
  cameraRafId = requestAnimationFrame(drawCameraFrame);
}

function openCamera(view) {
  cameraRotation = 0;
  const modal = document.getElementById('camera-modal');
  modal.dataset.view = view;
  modal.style.display = 'flex';
  const video = document.getElementById('camera-video');
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    .then(stream => {
      video.srcObject = stream;
      video.play();
      video.onloadedmetadata = () => { cameraRafId = requestAnimationFrame(drawCameraFrame); };
    })
    .catch(() => { closeCamera(); triggerUpload(view); });
}

function rotateCamera() {
  cameraRotation = (cameraRotation + 90) % 360;
}

function capturePhoto() {
  const canvas = document.getElementById('camera-canvas');
  const view   = document.getElementById('camera-modal').dataset.view;
  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    setImg(view, url);
    const a = document.createElement('a');
    a.href = url;
    a.download = `td-${view}-${Date.now()}.jpg`;
    a.click();
  }, 'image/jpeg', 0.92);
  closeCamera();
}

function closeCamera() {
  if (cameraRafId) { cancelAnimationFrame(cameraRafId); cameraRafId = null; }
  const video = document.getElementById('camera-video');
  if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());
  video.srcObject = null;
  cameraRotation = 0;
  document.getElementById('camera-modal').style.display = 'none';
}

// ══════════════════════════ PRINT CALIBRATION ══════════════════════════
function printCalibration() {
  window.open('/calibration.html', '_blank');

}