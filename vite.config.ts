import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";

// Standalone Vite config for the cesium-demo GVI proof of concept.
// This project is fully isolated from the existing cesium_demo application.
export default defineConfig({
  plugins: [react(), cesium()],
  server: {
    port: 5183,
  },
});
