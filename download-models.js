const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
const MODELS_DIR = path.join(__dirname, 'models');

const files = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin'
];

async function downloadFile(fileName) {
  const fileUrl = `${BASE_URL}${fileName}`;
  const destPath = path.join(MODELS_DIR, fileName);

  console.log(`Downloading ${fileName}...`);
  try {
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(destPath, buffer);
    console.log(`Saved ${fileName} successfully.`);
  } catch (error) {
    console.error(`Failed to download ${fileName}:`, error.message);
    throw error;
  }
}

async function main() {
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR);
    console.log(`Created directory: ${MODELS_DIR}`);
  }

  console.log('Starting Face-API model files download...');
  for (const file of files) {
    await downloadFile(file);
  }
  console.log('All model files downloaded successfully!');
}

main().catch(err => {
  console.error('Download process failed:', err);
  process.exit(1);
});
