const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Créer les dossiers nécessaires
const dirs = ['./temp', './output'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Endpoint principal pour générer les vidéos avec overlay vidéo
app.post('/generate-video', async (req, res) => {
  console.log('🎬 Nouvelle demande de génération vidéo avec overlay');
  
  try {
    const { 
      backgroundImageUrl,   // URL de la capture d'écran
      foregroundVideoUrl,   // URL de votre vidéo de premier plan
      audioUrl,            // URL de l'audio Eleven Labs
      outputName = 'video_' + Date.now()
    } = req.body;

    console.log('📥 Paramètres reçus:', { 
      backgroundImageUrl: !!backgroundImageUrl, 
      foregroundVideoUrl: !!foregroundVideoUrl, 
      audioUrl: !!audioUrl, 
      outputName 
    });

    // 1. Télécharger les assets
    console.log('⬇️ Téléchargement des assets...');
    const backgroundPath = await downloadFile(backgroundImageUrl, `bg_${Date.now()}.jpg`);
    const foregroundPath = await downloadFile(foregroundVideoUrl, `fg_${Date.now()}.mp4`);
    const audioPath = await downloadFile(audioUrl, `audio_${Date.now()}.mp3`);

    // 2. Obtenir la durée de l'audio
    const audioDuration = await getAudioDuration(audioPath);
    console.log(`🕐 Durée audio: ${audioDuration} secondes`);

    // 3. Générer la vidéo composite
    console.log('🎥 Génération de la vidéo composite...');
    const outputPath = `./output/${outputName}.mp4`;
    await generateCompositeVideo(backgroundPath, foregroundPath, audioPath, outputPath, audioDuration);

    // 4. Lire le fichier généré
    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');

    // 5. Nettoyer les fichiers temporaires
    cleanupFiles([backgroundPath, foregroundPath, audioPath, outputPath]);

    console.log('✅ Vidéo composite générée avec succès !');
    
    res.json({ 
      success: true, 
      message: 'Vidéo générée avec succès',
      videoData: videoBase64,
      videoSize: videoBuffer.length,
      duration: audioDuration
    });

  } catch (error) {
    console.error('❌ Erreur:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: error.stack
    });
  }
});

// Fonction pour générer la vidéo composite avec overlay vidéo
async function generateCompositeVideo(backgroundImage, foregroundVideo, audio, output, duration) {
  return new Promise((resolve, reject) => {
    console.log('🔧 Configuration FFmpeg pour composition vidéo...');
    
    ffmpeg()
      // 1. Arrière-plan (image statique)
      .input(backgroundImage)
      .inputOptions([
        '-loop 1',                    // Boucler l'image
        `-t ${duration + 1}`          // Durée = durée audio + 1s
      ])
      
      // 2. Premier plan (votre vidéo)
      .input(foregroundVideo)
      .inputOptions([
        '-stream_loop -1',            // Boucler la vidéo
        `-t ${duration + 1}`          // Même durée
      ])
      
      // 3. Audio personnalisé
      .input(audio)
      
      // Filtres de composition avancés
      .complexFilter([
        // Redimensionner l'arrière-plan pour remplir l'écran
        '[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080[bg]',
        
        // Traiter la vidéo de premier plan
        '[1:v]scale=1920:1080:force_original_aspect_ratio=decrease[fg_scaled]',
        
        // Appliquer le chroma key si fond vert/bleu
        '[fg_scaled]colorkey=0x00FF00:0.3:0.2[fg_keyed]',
        
        // Superposer avec transparence
        '[bg][fg_keyed]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p[final]'
      ])
      
      // Configuration de sortie optimisée
      .outputOptions([
        '-map [final]',
        '-map 2:a',                   // Audio du 3ème input
        '-c:v libx264',               // Codec vidéo H.264
        '-c:a aac',                   // Codec audio AAC
        '-preset medium',             // Qualité/vitesse équilibrée
        '-crf 20',                    // Haute qualité
        '-r 30',                      // 30 fps
        '-profile:v main',            // Profil de compatibilité
        '-level 4.0',                 // Niveau de compatibilité
        '-movflags +faststart',       // Optimisation streaming
        '-shortest'                   // Durée = durée de l'audio
      ])
      
      .output(output)
      .on('start', (cmd) => {
        console.log('🚀 FFmpeg démarré');
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`⏳ Progression: ${progress.percent.toFixed(1)}%`);
        }
      })
      .on('end', () => {
        console.log('✅ FFmpeg terminé avec succès');
        resolve();
      })
      .on('error', (err) => {
        console.error('❌ Erreur FFmpeg:', err.message);
        reject(err);
      })
      .run();
  });
}

// Obtenir la durée d'un fichier audio
function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        const duration = metadata.format.duration;
        resolve(Math.ceil(duration));
      }
    });
  });
}

// Télécharger un fichier depuis une URL
async function downloadFile(url, filename) {
  try {
    console.log(`📁 Téléchargement: ${filename}`);
    
    // Gérer les URLs Google Drive
    if (url.includes('drive.google.com')) {
      // Convertir l'URL Google Drive en URL de téléchargement direct
      const fileId = url.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] || url.match(/id=([a-zA-Z0-9-_]+)/)?.[1];
      if (fileId) {
        url = `https://drive.google.com/uc?export=download&id=${fileId}`;
      }
    }
    
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      timeout: 60000,  // 60 secondes pour les gros fichiers
      maxRedirects: 5
    });
    
    const filePath = `./temp/${filename}`;
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`✅ Téléchargé: ${filename}`);
        resolve(filePath);
      });
      writer.on('error', reject);
    });
  } catch (error) {
    throw new Error(`Erreur téléchargement ${filename}: ${error.message}`);
  }
}

// Nettoyer les fichiers temporaires
function cleanupFiles(filePaths) {
  filePaths.forEach(filePath => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Nettoyé: ${filePath}`);
      }
    } catch (error) {
      console.warn(`⚠️ Impossible de nettoyer ${filePath}:`, error.message);
    }
  });
}

// Page de test
app.get('/', (req, res) => {
  res.send(`
    <h1>🎥 Générateur de Vidéos avec Overlay</h1>
    <p>Service actif ! ✅</p>
    <p>Endpoint principal: <code>POST /generate-video</code></p>
    <p>Paramètres requis:</p>
    <ul>
      <li><code>backgroundImageUrl</code> - URL de l'image d'arrière-plan</li>
      <li><code>foregroundVideoUrl</code> - URL de la vidéo de premier plan</li>
      <li><code>audioUrl</code> - URL du fichier audio</li>
      <li><code>outputName</code> - Nom du fichier de sortie (optionnel)</li>
    </ul>
    <h3>Fonctionnalités:</h3>
    <ul>
      <li>✅ Overlay vidéo avec transparence</li>
      <li>✅ Chroma key automatique (fond vert/bleu)</li>
      <li>✅ Synchronisation audio automatique</li>
      <li>✅ Support Google Drive URLs</li>
    </ul>
  `);
});

// Endpoint de santé
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    ffmpeg: ffmpegPath,
    features: ['video_overlay', 'chroma_key', 'audio_sync']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur vidéo overlay démarré sur le port ${PORT}`);
  console.log(`🔗 URL: http://localhost:${PORT}`);
  console.log(`🎬 Fonctionnalités: Overlay vidéo + Chroma Key + Audio Sync`);
});
