import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      ignored: [
        "**/.llm_cache/**",
        "**/node_modules/**",
        "**/debug/**",
        "**/.git/**",
      ],
    },
  },
});
