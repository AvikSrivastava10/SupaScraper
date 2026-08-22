const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
}

export type NavKey = "dashboard" | "scrapers" | "activity" | "data" | "settings";

const NAV: readonly { key: NavKey; label: string; href: string }[] = [
  { key: "dashboard", label: "Dashboard", href: "/" },
  { key: "scrapers", label: "Scrapers", href: "/scrapers" },
  { key: "activity", label: "Activity", href: "/activity" },
  { key: "data", label: "Data", href: "/data" },
  { key: "settings", label: "Settings", href: "/settings" },
];

export interface PageOptions {
  readonly title: string;
  readonly nav: NavKey;
  readonly body: string;
  /** Seconds between refreshes. Null means do not refresh. */
  readonly refreshSeconds: number | null;
  readonly requiresToken: boolean;
  readonly canAddTargets: boolean;
}

/**
 * The palette.
 *
 * Monochrome carries the structure so the page stays calm, and exactly one hue
 * carries meaning: green for healthy. Red marks a failure and blue marks a time,
 * both used sparingly enough to stay noticeable. Status is never left to colour
 * alone; every state also has a word and a glyph, which is what keeps it readable
 * when the hues cannot be told apart.
 */
const STYLES = `
      :root { color-scheme: light;
        --paper:#ffffff; --ink:#0a0a0a; --ink-2:#3d3d3d; --ink-3:#6b6b6b;
        --line:#e2e2e2; --line-2:#c9c9c9; --wash:#fafafa; --wash-2:#f4f4f4;
        --good:#15803d; --good-bg:#f0fdf4; --good-line:#86efac;
        --bad:#b91c1c; --bad-bg:#fef2f2; --bad-line:#fca5a5;
        --time:#1d4ed8; }
      * { box-sizing:border-box; }
      html { -webkit-text-size-adjust:100%; }
      body { margin:0; background:var(--wash); color:var(--ink);
        font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
        line-height:1.55; -webkit-font-smoothing:antialiased; }

      /* ---- shell ---- */
      .shell { display:grid; grid-template-columns:15rem 1fr; min-height:100vh; }
      .side { background:var(--paper); border-right:1px solid var(--line);
        padding:1.15rem 0; position:sticky; top:0; align-self:start; height:100vh; }
      .brand { display:block; font-weight:800; font-size:1.05rem; letter-spacing:-.02em;
        padding:0 1.15rem 1rem; text-decoration:none; color:var(--ink);
        border-bottom:1px solid var(--line); }
      .brand .dot { display:inline-block; width:.5rem; height:.5rem; background:var(--good);
        border-radius:50%; margin-right:.45rem; vertical-align:middle; }
      nav { padding:.85rem .6rem; display:grid; gap:.1rem; }
      nav a { display:block; padding:.42rem .55rem; border-radius:4px; text-decoration:none;
        color:var(--ink-2); font-size:.88rem; font-weight:550; }
      nav a:hover { background:var(--wash-2); color:var(--ink); }
      nav a[aria-current="page"] { background:var(--ink); color:var(--paper); font-weight:650; }
      .side-foot { padding:.85rem 1.15rem; font-size:.72rem; color:var(--ink-3);
        border-top:1px solid var(--line); margin-top:.5rem; }
      main { padding:1.6rem 2rem 4rem; min-width:0; }
      .wrap { width:min(100%, 68rem); }

      /* ---- type ---- */
      h1 { margin:0 0 .3rem; font-size:1.75rem; letter-spacing:-.03em; font-weight:800; }
      h2 { margin:0; font-size:1.1rem; letter-spacing:-.015em; font-weight:700; }
      h3 { margin:0 0 .6rem; font-size:.7rem; text-transform:uppercase;
        letter-spacing:.1em; color:var(--ink-3); font-weight:750; }
      p { margin:.3rem 0; }
      a { color:var(--ink); }
      .lede { font-size:1.02rem; color:var(--ink-2); max-width:46rem; }
      .muted { color:var(--ink-3); } .small { font-size:.82rem; }
      .num { font-variant-numeric:tabular-nums; }
      .time { color:var(--time); font-variant-numeric:tabular-nums; }
      code { background:var(--wash-2); border:1px solid var(--line);
        padding:.04rem .32rem; border-radius:3px; font-size:.85em; }

      /* ---- surfaces: crisp 1px lines, no shadows ---- */
      .panel { background:var(--paper); border:1px solid var(--line);
        border-radius:4px; padding:1.15rem 1.25rem; margin-bottom:1rem; }
      .hero { background:var(--paper); border:1px solid var(--line); border-radius:4px;
        padding:1.9rem 2rem; margin-bottom:1rem; }
      .eyebrow { font-size:.68rem; text-transform:uppercase; letter-spacing:.16em;
        font-weight:750; color:var(--ink-3); margin-bottom:.55rem; }
      .hero h1 { font-size:2.5rem; line-height:1.05; }
      .tagline { font-size:1.22rem; font-weight:650; letter-spacing:-.02em;
        margin:.5rem 0 .7rem; }
      .capabilities { display:flex; flex-wrap:wrap; gap:1.1rem; margin-top:1.35rem;
        padding-top:1.1rem; border-top:1px solid var(--line); }
      .capability { display:inline-flex; align-items:center; gap:.42rem;
        font-size:.83rem; font-weight:600; color:var(--ink-2); }
      .capability .dot { width:.44rem; height:.44rem; border-radius:50%;
        background:var(--good); flex:none; }

      /* ---- stat tiles ---- */
      .tiles { display:grid; gap:.7rem; grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr)); }
      .tile { border:1px solid var(--line); border-radius:4px; padding:.7rem .8rem;
        background:var(--paper); }
      .tile .figure { font-size:1.45rem; font-weight:750; letter-spacing:-.03em;
        font-variant-numeric:tabular-nums; line-height:1.2; }
      .tile .caption { font-size:.7rem; text-transform:uppercase; letter-spacing:.08em;
        color:var(--ink-3); font-weight:650; margin-top:.1rem; }
      .tile.accent .figure { color:var(--good); }

      /* ---- status ---- */
      .status { display:inline-flex; align-items:center; gap:.4rem; font-weight:750;
        font-size:.72rem; text-transform:uppercase; letter-spacing:.08em;
        padding:.24rem .55rem; border-radius:3px; border:1px solid var(--line-2);
        white-space:nowrap; }
      .status .glyph { font-size:.62rem; line-height:1; }
      .status.good { color:var(--good); background:var(--good-bg); border-color:var(--good-line); }
      .status.bad  { color:var(--bad); background:var(--bad-bg); border-color:var(--bad-line); }
      .status.warn { color:var(--ink); background:var(--wash-2); border-color:var(--line-2); }
      .status.busy { color:var(--ink); background:var(--wash-2); border-color:var(--line-2); }
      .status.idle { color:var(--ink-3); background:var(--paper); }
      .status.busy .glyph { animation:spin 1.5s linear infinite; }
      @keyframes spin { to { transform:rotate(360deg) } }
      @media (prefers-reduced-motion:reduce) { .status.busy .glyph{animation:none} }

      /* ---- health ---- */
      .health { border:1px solid var(--line); border-radius:4px; padding:.85rem .95rem;
        min-width:13rem; }
      .health-rows { display:grid; gap:.4rem; margin-top:.7rem; }
      .health-row { display:grid; grid-template-columns:1fr 3.5rem; gap:.6rem;
        align-items:center; font-size:.83rem; }
      .health-row .k { color:var(--ink-2); }
      .health-row .v { text-align:right; font-weight:700; font-variant-numeric:tabular-nums; }
      .meter { grid-column:1 / -1; height:3px; background:var(--wash-2);
        border-radius:2px; overflow:hidden; }
      .meter span { display:block; height:100%; background:var(--good); }
      .meter.low span { background:var(--bad); }
      .health-foot { margin-top:.7rem; padding-top:.6rem; border-top:1px solid var(--line);
        font-size:.76rem; color:var(--ink-3); }

      /* ---- scraper cards ---- */
      .cards { display:grid; gap:1rem; }
      .card { background:var(--paper); border:1px solid var(--line); border-radius:4px;
        padding:1.15rem 1.25rem; }
      .card-top { display:flex; align-items:flex-start; justify-content:space-between;
        gap:1rem; flex-wrap:wrap; }
      .card h2 a { text-decoration:none; }
      .card h2 a:hover { text-decoration:underline; }
      .host { font-size:.83rem; color:var(--ink-3); word-break:break-all; }
      .open { font-size:.82rem; font-weight:650; text-decoration:none; white-space:nowrap; }
      .split { display:grid; gap:1.1rem; grid-template-columns:minmax(0,1fr) auto;
        align-items:start; margin-top:1.1rem; }
      @media (max-width:52rem) { .split { grid-template-columns:1fr; } .shell { grid-template-columns:1fr; }
        .side { position:static; height:auto; } main { padding:1.2rem; } }

      /* ---- contract fields ---- */
      .fields { display:grid; gap:.15rem; margin-top:.15rem; }
      .field-row { display:flex; align-items:baseline; gap:.45rem; font-size:.85rem; }
      .field-row .ok { color:var(--good); font-weight:800; }
      .field-row .name { font-weight:600; }
      .field-row .type { color:var(--ink-3); font-size:.78rem; }

      /* ---- activity ---- */
      .feed { list-style:none; margin:0; padding:0; }
      .feed li { display:grid; grid-template-columns:1rem 4.5rem 1fr; gap:.6rem;
        padding:.5rem 0; border-bottom:1px solid var(--line); align-items:baseline; }
      .feed li:last-child { border-bottom:none; }
      .feed .bullet { color:var(--ink-3); font-size:.6rem; text-align:center; }
      .feed .bullet.good { color:var(--good); }
      .feed .bullet.bad { color:var(--bad); }
      .feed .at { color:var(--time); font-size:.78rem; font-variant-numeric:tabular-nums; }
      .feed .what { font-size:.87rem; font-weight:600; }
      .feed .why { display:block; font-size:.81rem; color:var(--ink-3); font-weight:400; }
      .feed li.started .bullet { animation:blink 1.2s steps(3,end) infinite; }
      @keyframes blink { 50% { opacity:.2 } }
      @media (prefers-reduced-motion:reduce) { .feed li.started .bullet{animation:none} }

      /* ---- tables ---- */
      .scroll { overflow-x:auto; border:1px solid var(--line); border-radius:4px; }
      table { border-collapse:collapse; width:100%; font-size:.85rem; }
      th, td { text-align:left; padding:.5rem .65rem; border-bottom:1px solid var(--line);
        max-width:20rem; overflow-wrap:anywhere; }
      th { background:var(--wash-2); color:var(--ink-3); font-size:.68rem;
        text-transform:uppercase; letter-spacing:.07em; font-weight:750; white-space:nowrap; }
      tbody tr:last-child td { border-bottom:none; }

      /* ---- tabs ---- */
      .tabs { display:flex; gap:.3rem; border-bottom:1px solid var(--line);
        margin:1.1rem 0 1.2rem; flex-wrap:wrap; }
      .tabs a { padding:.5rem .85rem; text-decoration:none; font-size:.87rem;
        font-weight:650; color:var(--ink-3); border-bottom:2px solid transparent;
        margin-bottom:-1px; }
      .tabs a:hover { color:var(--ink); }
      .tabs a[aria-current="page"] { color:var(--ink); border-bottom-color:var(--good); }

      /* ---- controls ---- */
      button, .btn { font:inherit; font-weight:650; font-size:.88rem; color:var(--paper);
        background:var(--ink); border:1px solid var(--ink); border-radius:4px;
        padding:.5rem 1rem; cursor:pointer; text-decoration:none; display:inline-block; }
      button:hover:not(:disabled), .btn:hover { background:var(--ink-2); border-color:var(--ink-2); }
      button:disabled { background:var(--paper); color:var(--ink-3);
        border-color:var(--line-2); cursor:not-allowed; }
      .btn-quiet { background:var(--paper); color:var(--ink); border-color:var(--line-2); }
      .btn-quiet:hover { background:var(--wash-2); color:var(--ink); border-color:var(--ink); }
      :focus-visible { outline:2px solid var(--time); outline-offset:2px; }
      .actions { margin-top:1rem; display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; }

      .chips { display:flex; flex-wrap:wrap; gap:.35rem; }
      .chip { display:inline-block; background:var(--paper); border:1px solid var(--line-2);
        border-radius:3px; padding:.26rem .6rem; font-size:.78rem; font-weight:650;
        text-decoration:none; color:var(--ink); }
      .chip:hover { background:var(--ink); color:var(--paper); border-color:var(--ink); }

      /* ---- form ---- */
      .two-col { display:grid; gap:1.1rem; grid-template-columns:repeat(auto-fit,minmax(17rem,1fr)); }
      label { display:block; font-size:.78rem; font-weight:700; margin-bottom:.28rem; }
      input, textarea { font:inherit; font-size:.9rem; width:100%; background:var(--paper);
        color:var(--ink); border:1px solid var(--line-2); border-radius:4px;
        padding:.5rem .6rem; }
      input:focus, textarea:focus { border-color:var(--ink); }
      textarea { resize:vertical; min-height:5.4rem; }
      ::placeholder { color:#a3a3a3; }
      .hint { font-size:.77rem; color:var(--ink-3); margin-top:.25rem; }
      .form-foot { display:flex; justify-content:space-between; align-items:center;
        gap:.75rem; flex-wrap:wrap; margin-top:1.1rem; padding-top:1rem;
        border-top:1px solid var(--line); }

      /* ---- notices ---- */
      .notice { border:1px solid var(--line-2); border-left:3px solid var(--ink);
        background:var(--wash); padding:.6rem .8rem; border-radius:3px;
        margin-top:.9rem; font-size:.85rem; }
      .notice.bad { border-left-color:var(--bad); background:var(--bad-bg); }
      .notice.good { border-left-color:var(--good); background:var(--good-bg); }
      details summary { cursor:pointer; color:var(--ink-3); font-size:.8rem; font-weight:600; }
      .prompt { background:var(--wash); border:1px solid var(--line); border-radius:3px;
        padding:.6rem .7rem; font-size:.81rem; color:var(--ink-2); margin-top:.4rem; }
      .empty { text-align:center; padding:2.4rem 1rem; color:var(--ink-3); }
      .empty strong { display:block; color:var(--ink); font-size:1rem; margin-bottom:.3rem; }
      .row-between { display:flex; justify-content:space-between; align-items:center;
        gap:1rem; flex-wrap:wrap; }
`;

/**
 * Client script shared by every page.
 *
 * Token handling lives here because a protected deployment serves a public
 * dashboard whose own buttons would otherwise be unusable: the page never sent
 * the bearer token that the write endpoints require.
 */
const SCRIPT = (requiresToken: boolean): string => `
      const REQUIRES_TOKEN = ${requiresToken ? "true" : "false"};
      const KEY = "supascraper-token";

      function authHeaders() {
        const token = sessionStorage.getItem(KEY);
        return token ? { authorization: "Bearer " + token } : {};
      }

      function askForToken(force) {
        if (!REQUIRES_TOKEN) return true;
        if (!force && sessionStorage.getItem(KEY)) return true;
        const token = window.prompt("This deployment is protected. Enter the API token to continue:");
        if (!token) return false;
        sessionStorage.setItem(KEY, token.trim());
        return true;
      }

      async function send(url, options) {
        if (!askForToken(false)) throw new Error("An API token is required.");
        const call = () => fetch(url, {
          ...options,
          headers: { ...(options.headers || {}), ...authHeaders() },
        });
        let response = await call();
        if (response.status === 401) {
          sessionStorage.removeItem(KEY);
          if (!askForToken(true)) throw new Error("An API token is required.");
          response = await call();
        }
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || "HTTP " + response.status);
        }
        return response.json().catch(() => ({}));
      }

      for (const button of document.querySelectorAll("button[data-target]")) {
        button.addEventListener("click", async () => {
          const id = button.getAttribute("data-target");
          const original = button.textContent;
          button.disabled = true;
          button.textContent = "Collecting...";
          try {
            await send("/api/run?target=" + encodeURIComponent(id), { method: "POST" });
            setTimeout(() => { window.location.reload(); }, 1200);
          } catch (error) {
            button.disabled = false;
            button.textContent = original;
            window.alert("Could not start a run: " + error.message);
          }
        });
      }

      const toggle = document.getElementById("reveal-form");
      const panel = document.getElementById("create-panel");
      if (toggle && panel) {
        toggle.addEventListener("click", () => {
          const open = panel.hasAttribute("hidden");
          if (open) { panel.removeAttribute("hidden"); } else { panel.setAttribute("hidden", ""); }
          toggle.setAttribute("aria-expanded", open ? "true" : "false");
          if (open) { panel.querySelector("input")?.focus(); }
        });
      }

      const form = document.getElementById("add-form");
      if (form) {
        const note = document.getElementById("add-status");
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const button = form.querySelector("button[type=submit]");
          const data = new FormData(form);
          button.disabled = true;
          note.textContent = "Asking Bright Data to build the extractor. This takes 5 to 10 minutes.";
          try {
            await send("/api/targets", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                url: data.get("url"),
                description: data.get("description"),
                label: data.get("label") || undefined,
              }),
            });
            note.textContent = "Building. This page keeps refreshing on its own.";
            form.reset();
            setTimeout(() => { window.location.reload(); }, 1800);
          } catch (error) {
            button.disabled = false;
            note.textContent = "";
            window.alert("Could not add that site: " + error.message);
          }
        });
      }
`;

/** Wraps page content in the application shell. */
export function renderPage(options: PageOptions): string {
  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}"${
        item.key === options.nav ? ' aria-current="page"' : ""
      }>${item.label}</a>`,
  ).join("\n        ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${
      options.refreshSeconds === null
        ? ""
        : `<meta http-equiv="refresh" content="${String(options.refreshSeconds)}">`
    }
    <title>${escapeHtml(options.title)}</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <div class="shell">
      <aside class="side">
        <a class="brand" href="/"><span class="dot" aria-hidden="true"></span>SupaScraper</a>
        <nav aria-label="Sections">
        ${nav}
        </nav>
        <p class="side-foot">${
          options.canAddTargets
            ? "Extractors are built by Bright Data Scraper Studio."
            : "Bright Data CLI not detected."
        }</p>
      </aside>
      <main>
        <div class="wrap">
${options.body}
        </div>
      </main>
    </div>
    <script>${SCRIPT(options.requiresToken)}</script>
  </body>
</html>`;
}
