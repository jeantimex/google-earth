import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        port: 3000,
    },
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                map3d: resolve(__dirname, 'map3d.html'),
            }
        }
    }
});