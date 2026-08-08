import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      // On pointe directement la source TS de l'engine : pas d'étape de build
      // intermédiaire, et une modif de règle de jeu est rechargée à chaud.
      '@dc/engine': fileURLToPath(new URL('../../packages/engine/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Le client parle toujours à `/ws` sur sa propre origine : en dev Vite
    // proxifie vers le serveur de jeu, en prod c'est le même process.
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
