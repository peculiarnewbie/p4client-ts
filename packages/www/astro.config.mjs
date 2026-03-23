import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";

export default defineConfig({
  integrations: [
    starlight({
      title: "p4-ts",
      description: "Typed TypeScript helpers for working with the Perforce p4 CLI.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/peculiarnewbie/p4-ts"
        }
      ],
      sidebar: [
        {
          label: "Guides",
          items: [
            { label: "Getting Started", link: "/guides/getting-started/" },
            { label: "Effect Service", link: "/guides/effect-service/" },
            { label: "Testing and Fixtures", link: "/guides/testing-and-fixtures/" }
          ]
        },
        {
          ...typeDocSidebarGroup,
          label: "API",
          collapsed: false
        }
      ],
      plugins: [
        starlightTypeDoc({
          entryPoints: ["../core/src/public/index.ts"],
          tsconfig: "../core/tsconfig.json",
          output: "api",
          sidebar: {
            label: "API",
            collapsed: false
          },
          typeDoc: {
            hideGenerator: true,
            readme: "none",
            sort: ["source-order"]
          }
        })
      ]
    })
  ]
});
