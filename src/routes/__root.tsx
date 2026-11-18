import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import appCss from "../styles.css?url";

const themeBoot = `(function(){try{var t=localStorage.getItem("float-theme");if(t!=="day"&&t!=="night"){t=matchMedia("(prefers-color-scheme: dark)").matches?"night":"day"}document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="night"?"#0E1916":"#E4E8E2")}catch(e){}})();`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Float" },
      {
        name: "description",
        content: "Fund a tUSD8 vault and give agents capped, revocable spending rights on Aevum.",
      },
      { name: "theme-color", content: "#E4E8E2" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "stylesheet", href: appCss },
      {
        rel: "preload",
        href: "/fonts/switzer-400.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        href: "/fonts/gambarino-400.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
    ],
  }),
  component: () => (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>
        <PreviewHostBridge />
        <AuthProvider>
          <Outlet />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
