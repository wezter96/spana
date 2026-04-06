import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import astroMermaid from "astro-mermaid";

export default defineConfig({
  site: "https://wezter96.github.io",
  base: "/spana",
  integrations: [
    astroMermaid(),
    starlight({
      title: "spana",
      description: "TypeScript-native E2E testing for React Native + Web",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/wezter96/spana" }],
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
            { label: "Gherkin / BDD", slug: "writing-tests/gherkin" },
            { label: "Selectors", slug: "writing-tests/selectors" },
            { label: "Assertions", slug: "writing-tests/assertions" },
            { label: "Platform-Specific", slug: "writing-tests/platform-specific" },
          ],
        },
        {
          label: "CLI",
          items: [
            { label: "Commands", slug: "cli/commands" },
            { label: "Init", slug: "cli/init" },
            { label: "Studio", slug: "cli/studio" },
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
          label: "Guides",
          items: [
            { label: "Device Setup", slug: "guides/device-setup" },
            { label: "Cloud Providers", slug: "guides/cloud-providers" },
            { label: "Remote Execution", slug: "guides/remote-execution" },
            { label: "Debugging", slug: "guides/debugging" },
            { label: "CI/CD Integration", slug: "guides/ci-integration" },
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
