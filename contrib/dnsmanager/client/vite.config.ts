import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
        configure: (proxy, _options) => {
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            // Forward the real client IP to the backend
            const clientIp = req.socket.remoteAddress || 'unknown';
            proxyReq.setHeader('X-Forwarded-For', clientIp);
            proxyReq.setHeader('X-Real-IP', clientIp);
          });
        }
      }
    }
  }
});
