// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
var __electron_vite_injected_dirname = "C:\\Users\\maxst\\VSCodeProjects\\Axiom";
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "electron/main.ts"),
          archd: resolve(__electron_vite_injected_dirname, "archd/index.ts")
        }
      }
    },
    resolve: {
      alias: { "@shared": resolve(__electron_vite_injected_dirname, "src/shared") }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "electron/preload.ts") }
      }
    }
  },
  renderer: {
    root: resolve(__electron_vite_injected_dirname, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": resolve(__electron_vite_injected_dirname, "src/renderer"),
        "@shared": resolve(__electron_vite_injected_dirname, "src/shared")
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html") }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
