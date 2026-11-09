import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The 3D hero for doctine.com: one ES module, no external requests, no CSS (the website styles the host element).
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist-embed',
    emptyOutDir: true,
    sourcemap: false,
    lib: { entry: fileURLToPath(new URL('./src/embed.tsx', import.meta.url)), formats: ['es'], fileName: () => 'hero3d.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
