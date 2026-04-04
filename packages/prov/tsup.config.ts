import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: { index: "src/index.ts" },
		format: ["esm"],
		dts: true,
		sourcemap: true,
		clean: true,
		shims: true,
		external: [
			"effect",
			"@effect/cli",
			"@effect/platform",
			"@effect/platform-bun",
			"playwright-core",
		],
	},
	{
		entry: { cli: "src/cli/index.ts" },
		format: ["esm"],
		dts: false,
		sourcemap: true,
		clean: false,
		shims: true,
		external: [
			"effect",
			"@effect/cli",
			"@effect/platform",
			"@effect/platform-bun",
			"playwright-core",
		],
		banner: {
			js: "#!/usr/bin/env bun",
		},
	},
]);
