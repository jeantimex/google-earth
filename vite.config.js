import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ command }) => {
  const isProduction = command === 'build';
  
  return {
    // Use relative paths for production, absolute for development
    base: isProduction ? './' : '/',
    
    // Build configuration
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
        },
      },
      // Ensure assets use relative paths
      assetsDir: 'assets',
    },
    
    // Server configuration
    server: {
      port: 3000,
    }
  };
});