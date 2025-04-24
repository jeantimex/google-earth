import { defineConfig } from 'vite';
import { resolve } from 'path';
import fs from 'fs';

// Copy assets to dist folder during build
function copyAssetsPlugin() {
  return {
    name: 'copy-assets',
    buildEnd() {
      // Ensure the assets directory exists in dist
      const distAssetsDir = resolve(__dirname, 'dist/assets');
      if (!fs.existsSync(distAssetsDir)) {
        fs.mkdirSync(distAssetsDir, { recursive: true });
      }
      
      // Copy the video file
      const sourceVideo = resolve(__dirname, 'public/assets/emojidemo.mp4');
      const destVideo = resolve(__dirname, 'dist/assets/emojidemo.mp4');
      
      if (fs.existsSync(sourceVideo)) {
        fs.copyFileSync(sourceVideo, destVideo);
        console.log('Video file copied to dist/assets/');
      } else {
        console.warn('Video file not found in public/assets/');
      }
    }
  };
}

export default defineConfig(({ command }) => {
  const isProduction = command === 'build';
  
  return {
    // Use '/google-earth/' for GitHub Pages deployment
    base: isProduction ? '/google-earth/' : '/',
    
    // Build configuration
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
        },
      },
      // Ensure assets are properly handled
      assetsInclude: ['**/*.mp4'],
    },
    
    // Server configuration
    server: {
      port: 3000,
    },
    
    // Add custom plugins
    plugins: [copyAssetsPlugin()]
  };
});