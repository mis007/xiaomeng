import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// For internal debugging, a placeholder key is preset for out-of-the-box use.
// IMPORTANT: Replace this with your actual Gemini API key for the app to function correctly.
const GEMINI_API_KEY = "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

export default defineConfig(({ mode }) => {
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
