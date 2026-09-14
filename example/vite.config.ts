import { defineConfig } from 'vite';
import { tsNrepl } from '../src/vite-plugin.ts';

export default defineConfig({
  plugins: [tsNrepl()],
});
