// 来源: lib/app.dart

import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { AppInit } from "@/components/app-init";

export const metadata: Metadata = {
  title: "OpenPaw",
  description: "Local-first AI personal assistant",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "OpenPaw",
    statusBarStyle: "default",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh" className="h-full antialiased">
      <head>
        <meta name="theme-color" content="#2563eb" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
(function () {
  /* Hide body until React mounts or timeout */
  var LOADING_TIMEOUT = 5000;  /* max 5s mask */
  var REACT_TIMEOUT = 15000;   /* if React hasn't mounted in 15s, reload page */

  var style = document.createElement('style');
  style.textContent = 'body{visibility:hidden}html,body{height:100%;margin:0;padding:0;background:#fff;color:#171717;font-family:system-ui,-apple-system,sans-serif}@media(prefers-color-scheme:dark){html,body{background:#0a0a0a;color:#ededed}}*,::before,::after{box-sizing:border-box;border-width:0;border-style:solid;border-color:#e5e7eb}';
  document.head.appendChild(style);

  /* Show body after timeout or when React signals ready */
  window.__react_ready = false;
  window.__show_body = function () {
    if (style.parentNode) style.parentNode.removeChild(style);
  };

  var shown = false;
  function showBody() {
    if (shown) return;
    shown = true;
    window.__show_body();
  }

  /* Timeout fallback: show body even if CSS/React not ready */
  setTimeout(showBody, LOADING_TIMEOUT);

  /* React will call this after first render via AppInit */
  window.__mark_react_ready = function () {
    window.__react_ready = true;
    showBody();
  };

  /* If React hasn't mounted after REACT_TIMEOUT, reload to retry */
  setTimeout(function () {
    if (!window.__react_ready) {
      location.reload();
    }
  }, REACT_TIMEOUT);

  /* Suppress HMR race condition errors in WebView2 */
  var ignore = [
    'enqueueModel',
    'Router action dispatched before initialization',
  ];
  var origError = window.onerror;
  window.onerror = function (msg) {
    for (var i = 0; i < ignore.length; i++) {
      if (typeof msg === 'string' && msg.indexOf(ignore[i]) !== -1) return true;
    }
    if (origError) return origError.apply(this, arguments);
    return false;
  };
  window.addEventListener('error', function (e) {
    for (var i = 0; i < ignore.length; i++) {
      if (e.message && e.message.indexOf(ignore[i]) !== -1) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return false;
      }
    }
  }, true);
})();`,
          }}
        />
      </head>
      <body className="h-full">
        <AppInit />
        <AppShell>{children}</AppShell>
        <PWARegister />
      </body>
    </html>
  );
}

function PWARegister() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(
      () => {},
      () => {}
    );
  });
}`,
      }}
    />
  );
}
