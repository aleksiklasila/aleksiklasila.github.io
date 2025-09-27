<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AR Model Viewer</title>
  <script type="module" src="https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js"></script>
  <style>
    body, html {
      margin: 0;
      padding: 0;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      background-color: #000;
      overflow: hidden;
    }

    model-viewer {
      width: 100%;
      height: 100%;
    }

    #ar-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      background-color: rgba(0,0,0,0.7);
      color: white;
      font-size: 24px;
      cursor: pointer;
      z-index: 10;
      user-select: none;
      text-align: center;
      padding: 20px;
    }
  </style>
</head>
<body>

<model-viewer
  id="ar-model"
  src="https://modelviewer.dev/shared-assets/models/Astronaut.glb"
  alt="3D Astronaut"
  ar
  ar-modes="scene-viewer quick-look"
  environment-image="neutral"
  auto-rotate
  camera-controls
  shadow-intensity="1">
</model-viewer>

<div id="ar-overlay">Tap to View in AR</div>

<script>
  const modelViewer = document.getElementById('ar-model');
  const overlay = document.getElementById('ar-overlay');

  overlay.addEventListener('click', async () => {
    try {
      await modelViewer.activateAR(); // Opens camera in AR mode
      overlay.style.display = 'none'; // Remove overlay
    } catch (err) {
      alert("AR not supported on this device.");
      console.error(err);
    }
  });
</script>

</body>
</html>
