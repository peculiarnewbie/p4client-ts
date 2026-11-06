import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://p4client-ts.peculiarnewbie.com",
  integrations: [
    starlight({
      title: "p4-ts",
      description: "Typed TypeScript helpers for working with the Perforce p4 CLI.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/peculiarnewbie/p4client-ts"
        }
      ],
      sidebar: [
        {
          label: "Guides",
          items: [
            { label: "Getting Started", link: "/guides/getting-started/" },
            { label: "Effect Service", link: "/guides/effect-service/" },
            { label: "Testing and Fixtures", link: "/guides/testing-and-fixtures/" },
            { label: "Changelog", link: "/changelog/" }
          ]
        }
      ]
    })
  ]
});
