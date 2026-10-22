// marked 4.3.0 ships no type declarations; this covers the part dashboards use.
declare module "marked" {
  class Renderer {
    html(html: string, block?: boolean): string;
    link(href: string | null, title: string | null, text: string): string;
    image(href: string | null, title: string | null, text: string): string;
  }
  interface MarkedOptions {
    renderer?: Renderer;
    mangle?: boolean;
    headerIds?: boolean;
  }
  export const marked: {
    Renderer: typeof Renderer;
    parse(src: string, options?: MarkedOptions): string;
  };
}
