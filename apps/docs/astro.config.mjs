import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import astroMermaid from "astro-mermaid";

const site = process.env.SITE ?? "https://spana.antonwester.se";
const base = process.env.BASE ?? "/";

export default defineConfig({
  site,
  base,
  compressHTML: true,
  markdown: { processor: unified() },
  integrations: [
    astroMermaid({ mermaidConfig: { layout: "dagre", look: "classic" } }),
    starlight({
      title: "spana",
      pagefind: false,
      components: {
        PageTitle: "./src/components/PageTitle.astro",
        Search: "./src/components/Search.astro",
      },
      description:
        "The fastest AI-native E2E framework. Write one TypeScript test and run it across Web, iOS, Android, Electron, Electrobun, and WASM.",
      customCss: ["./src/styles/custom.css"],
      head: [
        {
          tag: "script",
          content: `(() => {
  const labelCodeRegions = () => {
    const pres = document.querySelectorAll(".expressive-code pre");
    pres.forEach((pre, idx) => {
      if (!pre.getAttribute("aria-label") && !pre.getAttribute("aria-labelledby")) {
        const fig = pre.closest("figure");
        const title = fig?.querySelector("figcaption .title")?.textContent?.trim();
        const lang = pre.getAttribute("data-language") || "code";
        pre.setAttribute("aria-label", title ? title + " (" + lang + ", #" + (idx + 1) + ")" : "Code example " + (idx + 1) + " (" + lang + ")");
      }
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", labelCodeRegions, { once: true });
  } else {
    labelCodeRegions();
  }
  const obs = new MutationObserver(labelCodeRegions);
  const startObs = () => document.body && obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["role"] });
  if (document.body) startObs();
  else document.addEventListener("DOMContentLoaded", startObs, { once: true });
})();`,
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: `${site.replace(/\/$/, "")}/assets/spana-social-card.png`,
          },
        },
        { tag: "meta", attrs: { property: "og:image:width", content: "1280" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "640" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content:
              "spana — The fastest AI-native E2E framework for Web, iOS, Android, Electron, Electrobun, and WASM.",
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
            content: `${site.replace(/\/$/, "")}/assets/spana-social-card.png`,
          },
        },
        {
          tag: "script",
          attrs: { type: "application/ld+json" },
          content: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "spana",
            applicationCategory: "DeveloperApplication",
            operatingSystem: "macOS, Linux, Windows, iOS, Android",
            url: site,
            codeRepository: "https://github.com/wezter96/spana",
            license: "https://www.apache.org/licenses/LICENSE-2.0",
            description:
              "The fastest AI-native E2E framework. Write one TypeScript test and run it across Web, iOS, Android, Electron, Electrobun, and WASM.",
            offers: {
              "@type": "Offer",
              price: "0",
              priceCurrency: "USD",
            },
          }),
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
            { label: "Performance: run it fastest", slug: "getting-started/fastest-path" },
            { label: "Compare with other tools", slug: "compare" },
          ],
        },
        {
          label: "Writing Tests",
          items: [
            { label: "Flows", slug: "writing-tests/flows" },
            { label: "Gherkin / BDD", slug: "writing-tests/gherkin" },
            { label: "Varar (Markdown specs)", slug: "writing-tests/varar" },
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
            { label: "Fast TypeScript Toolchain", slug: "guides/fast-toolchain" },
          ],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "reference" } }],
        },
      ],
    }),
  ],
});
