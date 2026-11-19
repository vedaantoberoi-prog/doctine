import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The 3D hero for doctine.com: one minified ES module, no CSS (the website styles the host element),
// no HTML page, and no requests to other sites.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist-embed',
    emptyOutDir: true,
    sourcemap: false,
    minify: 'esbuild',
    modulePreload: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/embed.tsx', import.meta.url)),
      preserveEntrySignatures: 'exports-only',
      output: { format: 'es', entryFileNames: 'hero3d.js', inlineDynamicImports: true },
    },
  },
});
