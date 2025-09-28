<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AR Model Viewer — Google Drive Support</title>

  <!-- model-viewer -->
  <script type="module" src="https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js"></script>

  <style>
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      background-color: #000;
      color: #fff;
      font-family: Arial, sans-serif;
      display: flex;
      flex-direction: column;
    }

    model-viewer {
      flex: 1 1 auto;
      width: 100%;
      height: 100%;
      background: #111;
    }

    #ar-overlay {
      position: absolute;
      inset: 0;
      display: none; /* hidden until model selected */
      justify-content: center;
      align-items: center;
      z-index: 10;
      background-color: rgba(0,0,0,0.7);
      font-size: 24px;
      text-align: center;
      cursor: pointer;
      padding: 20px;
      user-select: none;
    }

    #controls {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 20;
    }

    button {
      background: #1e90ff;
      border: none;
      padding: 10px 15px;
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      cursor: pointer;
    }

    button:hover {
      background: #0d6efd;
    }

    #note {
      position: absolute;
      top: 20px;
      left: 20px;
      z-index: 20;
      background: rgba(0,0,0,0.45);
      padding: 10px 12px;
      border-radius: 8px;
      max-width: 40%;
      font-size: 13px;
    }
  </style>
</head>
<body>

<model-viewer
  id="ar-model"
  alt="3D Model"
  src=""
  ar
  ar-modes="scene-viewer quick-look"
  environment-image="neutral"
  auto-rotate
  camera-controls
  shadow-intensity="1">
</model-viewer>

<div id="ar-overlay">Tap to View in AR</div>

<div id="controls">
  <button id="load-model-btn">Load from URL / Google Drive</button>
</div>

<div id="note">No model loaded. Click "Load from URL / Google Drive" to start.</div>

<script>
  const modelViewer = document.getElementById('ar-model');
  const overlay = document.getElementById('ar-overlay');
  const loadModelBtn = document.getElementById('load-model-btn');
  const note = document.getElementById('note');

  // Initially hide overlay
  overlay.style.display = 'none';

  overlay.addEventListener('click', async () => {
    try {
      await modelViewer.activateAR();
      overlay.style.display = 'none';
      note.textContent = 'AR session launched.';
    } catch (err) {
      alert("AR not supported on this device.");
      console.error(err);
    }
  });

  // Convert Google Drive share link to direct download link
  function convertDriveLink(url) {
    const match = url.match(/https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)\/view/);
    if (match && match[1]) {
      return `https://drive.google.com/uc?export=download&id=${match[1]}`;
    }
    return url; // return original URL if not a Google Drive link
  }

  loadModelBtn.addEventListener('click', () => {
    let url = prompt('Enter the HTTPS URL of your .glb/.gltf model (Google Drive links supported):');
    if (!url) return;

    url = convertDriveLink(url);
    modelViewer.src = url;

    // Enable AR overlay now that model is selected
    overlay.style.display = 'flex';
    overlay.textContent = 'Tap to View in AR';
    note.textContent = 'Loaded model: ' + url;
  });
</script>

</body>
</html>
