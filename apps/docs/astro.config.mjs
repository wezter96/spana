import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import astroMermaid from "astro-mermaid";

export default defineConfig({
  site: "https://wezter96.github.io",
  base: "/prov",
  integrations: [
    astroMermaid(),
    starlight({
      title: "prov",
      description: "TypeScript-native E2E testing for React Native + Web",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/wezter96/prov" }],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Quick Start", slug: "getting-started/quick-start" },
            { label: "Configuration", slug: "getting-started/configuration" },
          ],
        },
        {
          label: "Writing Tests",
          items: [
            { label: "Flows", slug: "writing-tests/flows" },
            { label: "Selectors", slug: "writing-tests/selectors" },
            { label: "Assertions", slug: "writing-tests/assertions" },
            { label: "Platform-Specific", slug: "writing-tests/platform-specific" },
          ],
        },
        {
          label: "CLI",
          items: [
            { label: "Commands", slug: "cli/commands" },
            { label: "Agent Commands", slug: "cli/agent-commands" },
          ],
        },
        {
          label: "Architecture",
          items: [
            { label: "Overview", slug: "architecture/overview" },
            { label: "Drivers", slug: "architecture/drivers" },
          ],
        },
        {
          label: "Reference",
          autogenerate: { directory: "reference" },
        },
      ],
    }),
  ],
});
