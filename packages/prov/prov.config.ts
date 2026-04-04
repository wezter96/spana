import { defineConfig } from "./src/schemas/config.js";

export default defineConfig({
	apps: {
		web: { url: "http://localhost:3001" },
		android: { packageName: "com.anonymous.mybettertapp" },
		ios: { bundleId: "com.apple.Preferences" },
	},
	defaults: {
		waitTimeout: 5_000,
		pollInterval: 200,
	},
	platforms: ["web"],
	flowDir: "./flows",
	reporters: ["console"],
});
