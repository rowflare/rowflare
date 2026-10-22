// Markdown for dashboard text blocks. Raw HTML is shown as text and only http(s) and mailto links are kept.
import { marked } from "marked";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeUrl = (href: string | null) => (href && /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null);

export function renderMarkdown(src: string): string {
  const renderer = new marked.Renderer();
  renderer.html = (html: string) => esc(html);
  renderer.link = (href: string | null, title: string | null, text: string) => {
    const url = safeUrl(href);
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${title}"` : ""}>${text}</a>` : text;
  };
  // marked has already escaped link titles and image text; the link address is raw.
  renderer.image = (_href: string | null, _title: string | null, text: string) => text ?? "";
  return marked.parse(src, { renderer, mangle: false, headerIds: false }) as string;
}
