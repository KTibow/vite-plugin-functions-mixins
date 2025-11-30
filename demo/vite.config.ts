import { defineConfig } from "vite";
import { functionsMixins } from "vite-plugin-functions-mixins";
import { svelte } from "@sveltejs/vite-plugin-svelte";
export default defineConfig({
  // @ts-ignore ts may or may not be stupid
  plugins: [svelte(), functionsMixins()],
});
