import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  publicDir: "public",
  plugins: [react()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    // Keep the grid's lazily loaded editors in the grid chunk so the first keystroke opens an editor instantly.
    rollupOptions: {
      output: {
        manualChunks: id => {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id) || id.includes("preload-helper")) return "react";
          if (/node_modules\/(@glideapps|lodash|marked|react-responsive-carousel)\//.test(id)) return "grid";
          return undefined;
        },
      },
      onwarn: (w, warn) => w.code !== "INVALID_ANNOTATION" && warn(w),
    },
  },
  server: { proxy: { "/api": { target: "http://localhost:8787", ws: true } } },
});
