import type { APIRoute } from "astro";

export const prerender = true;

const robotsTxt = `
User-agent: *
Disallow: /archive/?tag=
Disallow: /archive/?category=
Disallow: /archive/?uncategorized=
Disallow: /dynamic/comments/
Disallow: /assets/music/
Disallow: *.lrc
Disallow: /posts/guide/
Disallow: /posts/collapse-panels/
Disallow: /posts/markdown-tutorial/
Disallow: /posts/firefly/
Disallow: /posts/code-examples/
Disallow: /posts/katex-math-example/
Disallow: /posts/markdown-extended/
Disallow: /posts/markdown-mermaid/
Disallow: /posts/markdown-plantuml/
Disallow: /posts/video/
Disallow: /posts/demo/

Sitemap: ${new URL("sitemap-index.xml", import.meta.env.SITE).href}
`.trim();

export const GET: APIRoute = () => {
	return new Response(robotsTxt, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
};
