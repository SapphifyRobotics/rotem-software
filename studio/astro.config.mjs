import { defineConfig } from 'astro/config';
import rotemHub from './server/astro-hub.mjs';

// `npm run dev`: one URL with live reload, the hub inside it holding the board.
// `npm run build` writes dist/, which `npm start` serves through the standalone hub.
export default defineConfig({
  output: 'static',
  devToolbar: { enabled: false },
  server: { port: 4321, host: '127.0.0.1' },
  integrations: process.env.STUDIO_VISUAL_PREVIEW === '1' ? [] : [rotemHub()],
});
