import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import astroMermaid from "astro-mermaid";

const site = process.env.SITE ?? "https://spana.antonwester.se";
const base = process.env.BASE ?? "/";

export default defineConfig({
  site,
  base,
  integrations: [
    astroMermaid(),
    starlight({
      title: "spana",
      description:
        "Web-first, TypeScript-native E2E testing across Web, Capacitor/React Native (iOS & Android), Electron, and Electrobun — zero Appium required.",
      customCss: ["./src/styles/custom.css"],
      head: [
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: `${site.replace(/\/$/, "")}/assets/github-social-preview.png`,
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:card",
            content: "summary_large_image",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: `${site.replace(/\/$/, "")}/assets/github-social-preview.png`,
          },
        },
      ],
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
