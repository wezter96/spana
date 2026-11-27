import http from "node:http";
import { URL } from "node:url";

const PRIMARY_PORT = Number(process.env.STRESS_PORT || 4410);
const CROSS_ORIGIN_PORT = Number(process.env.STRESS_OOPIF_PORT || 4411);
const PRIMARY_ORIGIN = `http://127.0.0.1:${PRIMARY_PORT}`;
const CROSS_ORIGIN = `http://127.0.0.1:${CROSS_ORIGIN_PORT}`;

function sendHtml(res, html, status = 200, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(html);
}

function sendJson(res, data, status = 200, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function pageShell(title, body, headExtra = "", lang = "en") {
  return `<!doctype html>
<html${lang ? ` lang="${lang}"` : ""}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 20px; color: #111827; background: #ffffff; }
    button { padding: 8px 14px; border: 1px solid #d1d5db; background: #f9fafb; border-radius: 6px; cursor: pointer; font-size: 14px; }
    button:hover { background: #eef2ff; }
    input, select, textarea { padding: 6px 10px; border: 1px solid #9ca3af; border-radius: 4px; font-size: 14px; }
    .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
  </style>
  ${headExtra}
</head>
<body>
${body}
</body>
</html>`;
}

function renderP1Spa() {
  return pageShell(
    "Profile 1 - SPA Hydration & Split Text",
    `<main>
      <h1>SPA Hydration Lab</h1>
      <div id="hydration-root" data-testid="hydration-root">Loading shell...</div>
      <div class="card">
        <span id="split-node-badge" data-testid="split-badge"></span>
        <p id="markdown-para" data-testid="markdown-para">Visit <a href="/p1-spa#docs">https://spana.dev/docs</a> for guides and examples.</p>
        <ul id="markdown-list">
          <li data-testid="md-item-1"><strong>Rule 1:</strong> Always normalize split text nodes</li>
          <li data-testid="md-item-2"><em>Rule 2:</em> Support nested inline markup</li>
        </ul>
      </div>
      <div class="card">
        <label for="draft-input">Draft Note</label>
        <input id="draft-input" data-testid="draft-input" type="text" value="UniqueInputValueOnly" />
        <input id="submit-draft" data-testid="submit-draft" type="submit" value="Publish Draft Now" />
        <button id="submit-status" type="button" data-testid="submit-status">idle</button>
      </div>
      <div class="card">
        <div class="upper-item" data-testid="upper-card" style="text-transform: uppercase">alpha release v2</div>
        <div class="upper-item" data-testid="other-card" style="text-transform: uppercase">beta preview v1</div>
        <div id="dynamic-counter" data-testid="dynamic-counter">Items: 0</div>
        <button id="bump-counter" data-testid="bump-counter" type="button">Increment Counter</button>
      </div>
    </main>
    <script>
      // Build authentic React-style split text nodes inside a single span
      const badge = document.getElementById("split-node-badge");
      badge.appendChild(document.createTextNode("Alice"));
      badge.appendChild(document.createTextNode(" "));
      badge.appendChild(document.createTextNode("("));
      badge.appendChild(document.createTextNode("15"));
      badge.appendChild(document.createTextNode(" min)"));

      setTimeout(() => {
        const root = document.getElementById("hydration-root");
        root.innerHTML = '<button id="hydrated-cta" data-testid="hydrated-cta" type="button">Hydrated Action Ready</button><span id="hydrated-msg" data-testid="hydrated-msg"></span>';
        document.getElementById("hydrated-cta").addEventListener("click", () => {
          document.getElementById("hydrated-msg").textContent = "Hydration Click Confirmed";
        });
      }, 120);

      document.getElementById("submit-draft").addEventListener("click", () => {
        document.getElementById("submit-status").textContent = "published:" + document.getElementById("draft-input").value;
      });

      let count = 0;
      document.getElementById("bump-counter").addEventListener("click", () => {
        count += 1;
        document.getElementById("dynamic-counter").textContent = "Items: " + count;
      });
    </script>`,
  );
}

function renderP2Forms() {
  return pageShell(
    "Profile 2 - Forms, Base-UI Pointer, Fieldsets & Keys",
    `<main>
      <h1>Forms & Interaction Lab</h1>
      <div class="card">
        <button id="baseui-trigger" data-testid="baseui-trigger" type="button">Open BaseUI Menu</button>
        <div id="baseui-menu" data-testid="baseui-menu" style="display:none; margin-top:8px;">
          <button id="baseui-item-1" data-testid="baseui-item-1" type="button">Export CSV</button>
        </div>
        <div id="baseui-log" data-testid="baseui-log">closed</div>
      </div>

      <fieldset id="billing-fieldset">
        <legend>Billing Address</legend>
        <label for="street-input">Street</label>
        <input id="street-input" data-testid="street-input" type="text" placeholder="123 Main St" />
        <label for="country-select">Country</label>
        <select id="country-select" data-testid="country-select">
          <option value="us">United States</option>
          <option value="se">Sweden</option>
          <option value="jp">Japan</option>
        </select>
        <label><input id="agree-box" data-testid="agree-box" type="checkbox" /> Accept Terms</label>
      </fieldset>

      <div class="card">
        <button id="toggle-bold" data-testid="toggle-bold" type="button" aria-pressed="true">Bold</button>
        <button id="toggle-italic" data-testid="toggle-italic" type="button" aria-pressed="false">Italic</button>
      </div>

      <div class="card">
        <input id="shortcut-input" data-testid="shortcut-input" type="text" placeholder="Focus for shortcuts" />
        <div id="shortcut-log" data-testid="shortcut-log">none</div>
        <button id="mod-click-btn" data-testid="mod-click-btn" type="button">Modifier Click Target</button>
        <div id="mod-click-log" data-testid="mod-click-log">none</div>
      </div>

      <div class="card">
        <div id="resizer-track" style="position:relative; width:300px; height:40px; background:#f3f4f6; border:1px solid #d1d5db;">
          <div id="resizer-handle" data-testid="resizer-handle" style="position:absolute; left:10px; top:4px; width:24px; height:30px; background:#2563eb; cursor:ew-resize;"></div>
        </div>
        <div id="resizer-log" data-testid="resizer-log">moves:0,x:10</div>
      </div>

      <div class="card">
        <div id="drag-source" data-testid="drag-source" draggable="true" style="display:inline-block; padding:10px; background:#dbeafe; border:1px solid #3b82f6; margin-right:20px;">Task Alpha</div>
        <div id="drag-target" data-testid="drag-target" style="display:inline-block; padding:10px; min-width:140px; min-height:44px; background:#f3f4f6; border:2px dashed #6b7280;">Drop Zone</div>
        <div id="drag-log" data-testid="drag-log">waiting</div>
      </div>
    </main>
    <script>
      // @base-ui style strict pointerdown check: requires buttons === 1 && pointerType === "mouse"
      const trigger = document.getElementById("baseui-trigger");
      const menu = document.getElementById("baseui-menu");
      const baseLog = document.getElementById("baseui-log");
      trigger.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.buttons === 1) {
          menu.style.display = "block";
          baseLog.textContent = "opened:" + e.pointerType + ":" + e.buttons;
        } else {
          baseLog.textContent = "rejected:" + e.pointerType + ":" + e.buttons;
        }
      });
      document.getElementById("baseui-item-1").addEventListener("click", () => {
        baseLog.textContent = "item:Export CSV";
      });

      for (const id of ["toggle-bold", "toggle-italic"]) {
        const btn = document.getElementById(id);
        btn.addEventListener("click", () => {
          const next = btn.getAttribute("aria-pressed") === "true" ? "false" : "true";
          btn.setAttribute("aria-pressed", next);
        });
      }

      const shortcutLog = document.getElementById("shortcut-log");
      window.addEventListener("keydown", (e) => {
        const mods = [];
        if (e.ctrlKey) mods.push("Ctrl");
        if (e.metaKey) mods.push("Meta");
        if (e.altKey) mods.push("Alt");
        if (e.shiftKey) mods.push("Shift");
        const combo = (mods.length ? mods.join("+") + "+" : "") + e.key + "(" + e.code + ")";
        if (e.ctrlKey || e.metaKey || e.altKey || /^F\\d+$/.test(e.key)) {
          e.preventDefault();
          shortcutLog.textContent = combo;
        }
      });

      document.getElementById("mod-click-btn").addEventListener("click", (e) => {
        document.getElementById("mod-click-log").textContent =
          "ctrl=" + e.ctrlKey + ",shift=" + e.shiftKey + ",alt=" + e.altKey;
      });

      // Stepped mouse drag resizer
      const handle = document.getElementById("resizer-handle");
      const resizerLog = document.getElementById("resizer-log");
      let dragging = false;
      let moveCount = 0;
      let currentLeft = 10;
      handle.addEventListener("mousedown", (e) => {
        if (e.buttons === 1) {
          dragging = true;
          moveCount = 0;
        }
      });
      window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        moveCount += 1;
        const rect = document.getElementById("resizer-track").getBoundingClientRect();
        currentLeft = Math.max(0, Math.min(270, Math.round(e.clientX - rect.left)));
        handle.style.left = currentLeft + "px";
        resizerLog.textContent = "moves:" + moveCount + ",x:" + currentLeft;
      });
      window.addEventListener("mouseup", () => {
        dragging = false;
      });

      // HTML5 drag and drop with hover-expanded dropzone
      const src = document.getElementById("drag-source");
      const tgt = document.getElementById("drag-target");
      const dragLog = document.getElementById("drag-log");
      let sawPointerHover = false;
      tgt.addEventListener("mouseenter", () => { sawPointerHover = true; });
      src.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", "Task Alpha");
        dragLog.textContent = "started";
      });
      tgt.addEventListener("dragover", (e) => { e.preventDefault(); });
      tgt.addEventListener("drop", (e) => {
        e.preventDefault();
        const data = e.dataTransfer.getData("text/plain") || "Task Alpha";
        dragLog.textContent = "dropped:" + data + ":hover=" + sawPointerHover;
      });
    </script>`,
  );
}

function renderP3HoverVisibility() {
  return pageShell(
    "Profile 3 - Hover Media Queries, Focus & Visibility Filtering",
    `<main>
      <h1>Hover, Focus & Visibility Lab</h1>
      <div class="card">
        <div id="hover-row" data-testid="hover-row" class="hover-row">
          <span>Project Roadmap</span>
          <button id="hover-edit-btn" data-testid="hover-edit-btn" class="hover-action" type="button">Edit Row</button>
        </div>
        <div id="hover-status" data-testid="hover-status">idle</div>
        <div id="media-info" data-testid="media-info"></div>
      </div>

      <div class="card">
        <div id="focus-status" data-testid="focus-status"></div>
        <button id="focus-btn" data-testid="focus-btn" type="button">Focusable Button</button>
      </div>

      <!-- Hidden mobile drawer BEFORE visible desktop controls (classic responsive DOM trap) -->
      <aside id="mobile-drawer" style="display:none" aria-hidden="true">
        <button data-testid="nav-action" type="button" onclick="document.getElementById('nav-log').textContent='hidden-mobile'">Dashboard Action</button>
        <button data-testid="drawer-only-btn" type="button">Hidden Drawer Only</button>
        <div data-testid="panel-card">
          <span>Card Row</span>
          <button type="button" onclick="document.getElementById('nav-log').textContent='hidden-card'">Open Item</button>
        </div>
      </aside>

      <nav id="desktop-nav" class="card">
        <button data-testid="nav-action" type="button" onclick="document.getElementById('nav-log').textContent='desktop-0'">Dashboard Action</button>
        <button data-testid="nav-action" type="button" onclick="document.getElementById('nav-log').textContent='desktop-1'">Settings Action</button>
        <div data-testid="panel-card">
          <span>Card Row</span>
          <button type="button" onclick="document.getElementById('nav-log').textContent='visible-card'">Open Item</button>
        </div>
        <div id="nav-log" data-testid="nav-log">none</div>
      </nav>

      <div class="card">
        <button id="vt-trigger" data-testid="vt-trigger" type="button">Start Transition</button>
        <button id="vt-target" data-testid="vt-target" type="button">Post-Transition Target</button>
        <div id="vt-log" data-testid="vt-log">ready</div>
      </div>
    </main>
    <script>
      const hoverStatus = document.getElementById("hover-status");
      document.getElementById("hover-edit-btn").addEventListener("click", () => {
        hoverStatus.textContent = "edited";
      });
      const anyHover = window.matchMedia("(any-hover: hover)").matches;
      const hover = window.matchMedia("(hover: hover)").matches;
      const finePtr = window.matchMedia("(pointer: fine)").matches;
      document.getElementById("media-info").textContent =
        "anyHover=" + anyHover + ",hover=" + hover + ",fine=" + finePtr;

      const updateFocus = () => {
        document.getElementById("focus-status").textContent =
          "hasFocus=" + document.hasFocus();
      };
      updateFocus();
      setInterval(updateFocus, 50);

      document.getElementById("vt-trigger").addEventListener("click", () => {
        if (typeof document.startViewTransition === "function") {
          document.startViewTransition(() => {
            document.getElementById("vt-log").textContent = "transitioned";
          });
        } else {
          document.getElementById("vt-log").textContent = "transitioned";
        }
      });
      document.getElementById("vt-target").addEventListener("click", () => {
        document.getElementById("vt-log").textContent = "clicked-after-vt";
      });
    </script>`,
    `<style>
      .hover-row { display:flex; align-items:center; justify-content:space-between; padding:10px; border:1px solid #d1d5db; width:360px; }
      .hover-action { display: none; }
      @media (any-hover: hover) and (hover: hover) {
        .hover-row:hover .hover-action { display: inline-block; }
      }
      #focus-btn:focus-visible { outline: 3px solid #2563eb; }
    </style>`,
  );
}

function renderP4Iframes() {
  return pageShell(
    "Profile 4 - Scaled Iframes, OOPIFs & Sandboxed Iframes",
    `<main>
      <h1>Iframe & OOPIF Lab</h1>
      <div style="display:flex; flex-wrap:wrap; gap:16px;">
        <div style="width:260px; height:180px; overflow:hidden; border:1px solid #9ca3af;">
          <iframe
            id="scaled-iframe"
            data-testid="scaled-iframe"
            src="/p4-child-same"
            style="width:480px; height:320px; transform:scale(0.5); transform-origin:0 0; border:4px solid #3b82f6;"
          ></iframe>
        </div>

        <div style="width:260px; height:180px; overflow:hidden; border:1px solid #9ca3af;">
          <iframe
            id="nested-outer"
            data-testid="nested-outer"
            src="/p4-nested-outer"
            style="width:320px; height:220px; transform:scale(0.75); transform-origin:0 0; border:2px solid #10b981;"
          ></iframe>
        </div>

        <iframe
          id="oopif-static"
          data-testid="oopif-static"
          src="${CROSS_ORIGIN}/oopif-child"
          style="width:260px; height:140px; border:2px solid #f59e0b;"
        ></iframe>

        <iframe
          id="oopif-dynamic"
          data-testid="oopif-dynamic"
          src="about:blank"
          style="width:260px; height:140px; border:2px solid #ef4444;"
        ></iframe>

        <div style="width:200px; height:120px; overflow:hidden; border:1px solid #9ca3af;">
          <iframe
            id="oopif-scaled"
            data-testid="oopif-scaled"
            src="${CROSS_ORIGIN}/oopif-scaled"
            style="width:320px; height:180px; transform:scale(0.6); transform-origin:0 0; border:2px solid #8b5cf6;"
          ></iframe>
        </div>

        <iframe
          id="sandbox-scripts"
          data-testid="sandbox-scripts"
          sandbox="allow-scripts"
          srcdoc="<!doctype html><html><body style='margin:8px;font-family:sans-serif'><button id='sb-btn' data-testid='sb-btn' onclick=&quot;document.getElementById('sb-out').textContent='sandbox-clicked'&quot;>Sandbox Script Button</button><div id='sb-out' data-testid='sb-out'>idle</div></body></html>"
          style="width:240px; height:110px; border:1px solid #6b7280;"
        ></iframe>

        <iframe
          id="sandbox-same-origin"
          data-testid="sandbox-same-origin"
          sandbox="allow-same-origin"
          src="/p4-sandbox-no-scripts"
          style="width:240px; height:110px; border:1px solid #6b7280;"
        ></iframe>

        <iframe
          id="sandbox-strict"
          data-testid="sandbox-strict"
          sandbox=""
          srcdoc="<!doctype html><html><body style='margin:8px;font-family:sans-serif'><p data-testid='strict-p'>Strict Sandbox Static</p></body></html>"
          style="width:240px; height:110px; border:1px solid #6b7280;"
        ></iframe>
      </div>

      <div class="card" style="margin-top:14px;">
        <button id="mount-late-iframe" data-testid="mount-late-iframe" type="button">Mount Late Iframe</button>
        <button id="mount-late-oopif" data-testid="mount-late-oopif" type="button">Mount Late OOPIF</button>
        <div id="late-container"></div>
      </div>
    </main>
    <script>
      // Dynamically update oopif-dynamic from about:blank -> cross-origin URL after 100ms
      setTimeout(() => {
        document.getElementById("oopif-dynamic").src = "${CROSS_ORIGIN}/oopif-dynamic";
      }, 100);

      document.getElementById("mount-late-iframe").addEventListener("click", () => {
        setTimeout(() => {
          const f = document.createElement("iframe");
          f.id = "late-same-iframe";
          f.setAttribute("data-testid", "late-same-iframe");
          f.src = "/p4-child-same";
          f.style.cssText = "width:240px;height:110px;border:1px solid #111;";
          document.getElementById("late-container").appendChild(f);
        }, 180);
      });

      document.getElementById("mount-late-oopif").addEventListener("click", () => {
        setTimeout(() => {
          const f = document.createElement("iframe");
          f.id = "late-oopif";
          f.setAttribute("data-testid", "late-oopif");
          f.src = "${CROSS_ORIGIN}/oopif-late";
          f.style.cssText = "width:240px;height:110px;border:1px solid #111;";
          document.getElementById("late-container").appendChild(f);
        }, 180);
      });
    </script>`,
  );
}

function renderP5MultitabNetwork() {
  return pageShell(
    "Profile 5 - Multi-Tab, Network & InitScript",
    `<main>
      <h1>Multi-Tab, Network & Context Lab</h1>
      <div class="card">
        <a id="open-popup-link" data-testid="open-popup-link" href="/p5-popup" target="_blank" rel="noopener">Open Secondary Tab</a>
        <button id="fetch-items-btn" data-testid="fetch-items-btn" type="button">Fetch Items</button>
        <button id="fetch-echo-btn" data-testid="fetch-echo-btn" type="button">Fetch Echo</button>
        <button id="fetch-blocked-btn" data-testid="fetch-blocked-btn" type="button">Fetch Blocked</button>
        <pre id="fetch-result" data-testid="fetch-result">idle</pre>
      </div>
      <div class="card">
        <div id="init-token" data-testid="init-token"></div>
        <div id="ua-info" data-testid="ua-info"></div>
        <div id="lang-info" data-testid="lang-info"></div>
        <button id="call-exposed-btn" data-testid="call-exposed-btn" type="button">Call Exposed Fn</button>
        <div id="exposed-result" data-testid="exposed-result">none</div>
      </div>
    </main>
    <script>
      document.getElementById("init-token").textContent = String(window.__STRESS_INIT_TOKEN__ || "none");
      document.getElementById("ua-info").textContent = navigator.userAgent;
      document.getElementById("lang-info").textContent = navigator.language;

      document.getElementById("fetch-items-btn").addEventListener("click", async () => {
        try {
          const r = await fetch("/api/items");
          const text = await r.text();
          document.getElementById("fetch-result").textContent = r.status + ":" + text;
        } catch (err) {
          document.getElementById("fetch-result").textContent = "error:" + err.message;
        }
      });

      document.getElementById("fetch-echo-btn").addEventListener("click", async () => {
        try {
          const r = await fetch("/api/echo", {
            method: "POST",
            headers: { "content-type": "application/json", "x-client": "web" },
            body: JSON.stringify({ hello: "world" }),
          });
          const text = await r.text();
          document.getElementById("fetch-result").textContent = r.status + ":" + text;
        } catch (err) {
          document.getElementById("fetch-result").textContent = "error:" + err.message;
        }
      });

      document.getElementById("fetch-blocked-btn").addEventListener("click", async () => {
        try {
          const r = await fetch("/api/blocked-resource");
          document.getElementById("fetch-result").textContent = "unexpected:" + r.status;
        } catch (err) {
          document.getElementById("fetch-result").textContent = "blocked:" + err.name;
        }
      });

      document.getElementById("call-exposed-btn").addEventListener("click", async () => {
        if (typeof window.__stressMultiply === "function") {
          const val = await window.__stressMultiply(6, 7);
          document.getElementById("exposed-result").textContent = String(val);
        } else {
          document.getElementById("exposed-result").textContent = "missing";
        }
      });
    </script>`,
  );
}

function renderP6AuthLogin() {
  return pageShell(
    "Profile 6 - Auth Login",
    `<main>
      <h1>Sign In</h1>
      <form id="login-form">
        <label for="email">Email</label>
        <input id="email" data-testid="login-email" type="email" />
        <label for="password">Password</label>
        <input id="password" data-testid="login-password" type="password" />
        <button id="login-submit" data-testid="login-submit" type="submit">Sign In</button>
      </form>
      <div id="login-status" data-testid="login-status">signed-out</div>
    </main>
    <script>
      document.getElementById("login-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = document.getElementById("email").value;
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        });
        if (res.ok) {
          localStorage.setItem("stress_user", email);
          document.getElementById("login-status").textContent = "signed-in:" + email;
          window.location.href = "/p6-dashboard";
        }
      });
    </script>`,
  );
}

function renderP6Dashboard(cookieHeader) {
  const authed = (cookieHeader || "").includes("stress_session=valid");
  return pageShell(
    "Profile 6 - Auth Dashboard",
    `<main>
      <h1>Workspace Dashboard</h1>
      <div id="auth-cookie-state" data-testid="auth-cookie-state">${authed ? "cookie:valid" : "cookie:missing"}</div>
      <div id="auth-storage-state" data-testid="auth-storage-state"></div>
      <div id="worker-marker" data-testid="worker-marker">ready</div>
    </main>
    <script>
      document.getElementById("auth-storage-state").textContent =
        "user:" + (localStorage.getItem("stress_user") || "anonymous");
    </script>`,
  );
}

function renderP7LargeDom() {
  return pageShell(
    "Profile 7 - Large DOM 4200 Rows & SSE",
    `<main>
      <h1>Large DOM (4,200 rows) & Live SSE</h1>
      <div class="card" style="position:sticky; top:0; background:#fff; z-index:10; display:flex; gap:10px; align-items:center;">
        <label for="row-filter">Filter rows</label>
        <input id="row-filter" data-testid="row-filter" type="search" placeholder="Search SKU or region..." />
        <span id="visible-count" data-testid="visible-count">4200</span>
        <button id="start-sse" data-testid="start-sse" type="button">Connect SSE</button>
        <span id="sse-latest" data-testid="sse-latest">sse:idle</span>
      </div>
      <table id="big-table" style="width:100%; border-collapse:collapse;">
        <thead><tr><th>ID</th><th>SKU</th><th>Region</th><th>Status</th><th>Action</th></tr></thead>
        <tbody id="big-tbody"></tbody>
      </table>
      <div class="card" style="margin-top:20px;">
        <button id="bottom-footer-cta" data-testid="bottom-footer-cta" type="button">Confirm All 4200 Rows</button>
        <span id="footer-status" data-testid="footer-status">pending</span>
      </div>
    </main>
    <script>
      const regions = ["us-east", "eu-north", "ap-south", "us-west"];
      const statuses = ["active", "queued", "paused"];
      const tbody = document.getElementById("big-tbody");
      const frag = document.createDocumentFragment();
      const rows = [];
      for (let i = 1; i <= 4200; i++) {
        const tr = document.createElement("tr");
        tr.className = "data-row";
        tr.dataset.rowId = String(i);
        const sku = "SKU-" + String(i).padStart(4, "0");
        const region = regions[i % regions.length];
        const status = statuses[i % statuses.length];
        tr.dataset.search = (sku + " " + region + " " + status).toLowerCase();
        tr.innerHTML =
          "<td>" + i + "</td>" +
          "<td>" + sku + "</td>" +
          "<td>" + region + "</td>" +
          "<td>" + status + "</td>" +
          '<td><button type="button" data-testid="row-btn-' + i + '">Inspect ' + sku + "</button></td>";
        rows.push(tr);
        frag.appendChild(tr);
      }
      tbody.appendChild(frag);
      tbody.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (btn) {
          document.getElementById("footer-status").textContent = "inspected:" + btn.textContent;
        }
      });

      document.getElementById("row-filter").addEventListener("input", (e) => {
        const q = e.target.value.trim().toLowerCase();
        let shown = 0;
        for (const tr of rows) {
          const match = !q || tr.dataset.search.includes(q);
          tr.style.display = match ? "" : "none";
          if (match) shown += 1;
        }
        document.getElementById("visible-count").textContent = String(shown);
      });

      document.getElementById("bottom-footer-cta").addEventListener("click", () => {
        document.getElementById("footer-status").textContent = "confirmed:4200";
      });

      document.getElementById("start-sse").addEventListener("click", () => {
        const es = new EventSource("/api/events");
        es.addEventListener("tick", (ev) => {
          document.getElementById("sse-latest").textContent = "sse:" + ev.data;
          if (ev.data === "4") es.close();
        });
      });
    </script>`,
  );
}

function renderP8A11yClean() {
  return pageShell(
    "Profile 8 - Clean WCAG Page",
    `<header><nav aria-label="Main navigation"><a href="#content">Skip to main</a></nav></header>
    <main id="content">
      <h1>Accessible Settings</h1>
      <form>
        <label for="display-name">Display Name</label>
        <input id="display-name" name="displayName" type="text" value="Anton" />
        <button type="submit">Save Preferences</button>
      </form>
      <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%232563eb'/%3E%3C/svg%3E" alt="Blue square badge" width="40" height="40" />
    </main>`,
  );
}

function renderP8A11yBroken() {
  return pageShell(
    "Profile 8 - Broken WCAG Page",
    `<main>
      <h1>Broken Accessibility Sample</h1>
      <div id="broken-region">
        <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23ef4444'/%3E%3C/svg%3E" width="40" height="40" />
        <button id="icon-only-btn" type="button"></button>
      </div>
      <div id="clean-region">
        <button type="button">Properly Labeled Action</button>
      </div>
    </main>`,
    "",
    "", // intentionally omit lang attribute on <html>
  );
}

function renderP8Visual(variant) {
  const accent = variant === "mismatch" ? "#dc2626" : "#2563eb";
  const shift = variant === "shifted" ? "margin-left: 1px;" : "";
  const dynamicText = variant === "masked" ? "Timestamp: 99:99:99" : "Timestamp: 12:34:56";
  return pageShell(
    "Profile 8 - Visual Diff Lab",
    `<main>
      <div id="visual-card" data-testid="visual-card" style="width:320px; height:180px; background:#f8fafc; border:2px solid #1e293b; border-radius:10px; padding:16px; ${shift}">
        <div style="width:80px; height:40px; background:${accent}; border-radius:6px; margin-bottom:12px;"></div>
        <div style="font-size:18px; font-weight:600; color:#0f172a;">Deterministic Banner</div>
        <div id="dynamic-clock" data-testid="dynamic-clock" style="margin-top:8px; font-size:14px; color:#475569;">${dynamicText}</div>
      </div>
    </main>`,
  );
}

function renderP9Mobile() {
  return pageShell(
    "Profile 9 - Mobile Viewport & Touch",
    `<header id="sticky-header" style="position:fixed; top:0; left:0; right:0; height:56px; background:#111827; color:#fff; display:flex; align-items:center; justify-content:space-between; padding:0 16px; z-index:50;">
      <strong>Spana Mobile</strong>
      <button id="menu-toggle" data-testid="menu-toggle" type="button" style="background:#374151; color:#fff; border:none;">Menu</button>
    </header>
    <nav id="mobile-nav-drawer" data-testid="mobile-nav-drawer" style="display:none; position:fixed; top:56px; left:0; right:0; background:#1f2937; color:#fff; padding:16px; z-index:45;">
      <button id="drawer-nav-orders" data-testid="drawer-nav-orders" type="button">Orders</button>
      <button id="drawer-close" data-testid="drawer-close" type="button">Close Menu</button>
    </nav>
    <main style="padding-top:72px;">
      <div id="vp-info" data-testid="vp-info"></div>
      <div id="mobile-log" data-testid="mobile-log">idle</div>
      <div class="card">
        <div id="gesture-box" data-testid="gesture-box" style="height:100px; background:#eff6ff; border:2px solid #3b82f6; display:flex; align-items:center; justify-content:center; user-select:none;">Gesture Pad</div>
        <div id="gesture-log" data-testid="gesture-log">none</div>
      </div>
      <div class="card">
        <a id="subpage-link" data-testid="subpage-link" href="/p9-mobile-sub">Go to Mobile Subpage</a>
      </div>
      <div style="height:1400px; background:linear-gradient(#f9fafb, #e5e7eb); margin:16px 0; padding:16px;">Scroll Spacer</div>
      <div class="card">
        <button id="below-fold-cta" data-testid="below-fold-cta" type="button">Complete Mobile Checkout</button>
      </div>
    </main>
    <script>
      const updateVp = () => {
        document.getElementById("vp-info").textContent = window.innerWidth + "x" + window.innerHeight;
      };
      updateVp();
      window.addEventListener("resize", updateVp);

      const drawer = document.getElementById("mobile-nav-drawer");
      document.getElementById("menu-toggle").addEventListener("click", () => {
        drawer.style.display = drawer.style.display === "none" ? "block" : "none";
      });
      document.getElementById("drawer-nav-orders").addEventListener("click", () => {
        document.getElementById("mobile-log").textContent = "nav:orders";
        drawer.style.display = "none";
      });
      document.getElementById("drawer-close").addEventListener("click", () => {
        drawer.style.display = "none";
      });
      document.getElementById("below-fold-cta").addEventListener("click", () => {
        document.getElementById("mobile-log").textContent = "checkout:done";
      });

      const gbox = document.getElementById("gesture-box");
      const glog = document.getElementById("gesture-log");
      let downAt = 0;
      let startX = 0;
      gbox.addEventListener("dblclick", () => { glog.textContent = "dblclick"; });
      gbox.addEventListener("mousedown", (e) => { downAt = Date.now(); startX = e.clientX; });
      gbox.addEventListener("mouseup", (e) => {
        const dt = Date.now() - downAt;
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 40) {
          glog.textContent = dx < 0 ? "swipe:left" : "swipe:right";
        } else if (dt >= 250) {
          glog.textContent = "longpress:" + dt;
        }
      });
    </script>`,
  );
}

function renderP10Resilience() {
  return pageShell(
    "Profile 10 - Resilience & Chaos",
    `<main>
      <h1>Resilience & Chaos Lab</h1>
      <div class="card">
        <button id="emit-console" data-testid="emit-console" type="button">Emit Console Logs</button>
        <button id="emit-js-error" data-testid="emit-js-error" type="button">Throw JS Error</button>
        <a id="download-link" data-testid="download-link" href="/api/download">Download Report</a>
        <a id="popup-link" data-testid="popup-link" href="/p5-popup" target="_blank" rel="noopener">Open Popup</a>
        <div id="reload-counter" data-testid="reload-counter"></div>
      </div>
    </main>
    <script>
      const count = Number(sessionStorage.getItem("p10_reloads") || "0") + 1;
      sessionStorage.setItem("p10_reloads", String(count));
      document.getElementById("reload-counter").textContent = "loads:" + count;

      document.getElementById("emit-console").addEventListener("click", () => {
        console.log("stress-info-msg");
        console.warn("stress-warn-msg");
        console.error("stress-error-msg");
      });
      document.getElementById("emit-js-error").addEventListener("click", () => {
        setTimeout(() => {
          throw new Error("IntentionalChaosRuntimeError");
        }, 10);
      });
    </script>`,
  );
}

const primaryServer = http.createServer((req, res) => {
  const u = new URL(req.url || "/", PRIMARY_ORIGIN);
  const path = u.pathname;

  if (path === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (path === "/p1-spa") return sendHtml(res, renderP1Spa());
  if (path === "/p2-forms") return sendHtml(res, renderP2Forms());
  if (path === "/p3-hover-visibility") return sendHtml(res, renderP3HoverVisibility());
  if (path === "/p4-iframes") return sendHtml(res, renderP4Iframes());
  if (path === "/p4-child-same") {
    return sendHtml(
      res,
      pageShell(
        "Same-Origin Child",
        `<button id="same-child-btn" data-testid="same-child-btn" style="margin-top:40px; margin-left:40px;" onclick="document.getElementById('same-child-out').textContent='same-clicked'">Click Scaled Child</button>
         <div id="same-child-out" data-testid="same-child-out">idle</div>`,
      ),
    );
  }
  if (path === "/p4-nested-outer") {
    return sendHtml(
      res,
      pageShell(
        "Nested Outer",
        `<iframe id="nested-inner" data-testid="nested-inner" src="/p4-nested-inner" style="width:260px; height:160px; transform:scale(0.8); transform-origin:0 0; border:2px solid #059669;"></iframe>`,
      ),
    );
  }
  if (path === "/p4-nested-inner") {
    return sendHtml(
      res,
      pageShell(
        "Nested Inner",
        `<button id="nested-btn" data-testid="nested-btn" onclick="document.getElementById('nested-out').textContent='nested-clicked'">Nested Scaled Button</button>
         <div id="nested-out" data-testid="nested-out">idle</div>`,
      ),
    );
  }
  if (path === "/p4-sandbox-no-scripts") {
    return sendHtml(
      res,
      pageShell(
        "Sandbox Same Origin No Scripts",
        `<div data-testid="sb-same-origin-text">Same-Origin Sandboxed Content</div>`,
      ),
    );
  }
  if (path === "/p5-multitab-network") return sendHtml(res, renderP5MultitabNetwork());
  if (path === "/p5-popup") {
    return sendHtml(
      res,
      pageShell(
        "Secondary Tab",
        `<h2 data-testid="popup-heading">Secondary Tab Loaded</h2><button id="popup-action" data-testid="popup-action" onclick="document.getElementById('popup-out').textContent='popup-ok'">Confirm Popup</button><div id="popup-out" data-testid="popup-out">idle</div>`,
      ),
    );
  }
  if (path === "/p6-login") return sendHtml(res, renderP6AuthLogin());
  if (path === "/p6-dashboard") return sendHtml(res, renderP6Dashboard(req.headers.cookie));
  if (path === "/p7-large-dom") return sendHtml(res, renderP7LargeDom());
  if (path === "/p8-a11y-clean") return sendHtml(res, renderP8A11yClean());
  if (path === "/p8-a11y-broken") return sendHtml(res, renderP8A11yBroken());
  if (path === "/p8-visual")
    return sendHtml(res, renderP8Visual(u.searchParams.get("variant") || "base"));
  if (path === "/p9-mobile") return sendHtml(res, renderP9Mobile());
  if (path === "/p9-mobile-sub") {
    return sendHtml(
      res,
      pageShell(
        "Mobile Subpage",
        `<main><h1 data-testid="subpage-title">Mobile Subpage</h1></main>`,
      ),
    );
  }
  if (path === "/p10-resilience") return sendHtml(res, renderP10Resilience());

  // API endpoints
  if (path === "/api/items") {
    return sendJson(res, { source: "server", items: ["alpha", "beta", "gamma"] });
  }
  if (path === "/api/echo") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      sendJson(res, {
        source: "server",
        method: req.method,
        xClient: req.headers["x-client"] || null,
        xExtra: req.headers["x-extra"] || null,
        body,
      });
    });
    return;
  }
  if (path === "/api/blocked-resource") {
    return sendJson(res, { secret: "should-be-blocked" });
  }
  if (path === "/api/auth/login" && req.method === "POST") {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "stress_session=valid; Path=/; SameSite=Lax",
    });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (path === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let tick = 1;
    const iv = setInterval(() => {
      res.write(`event: tick\ndata: ${tick}\n\n`);
      if (tick >= 4) {
        clearInterval(iv);
        res.end();
      }
      tick += 1;
    }, 35);
    req.on("close", () => clearInterval(iv));
    return;
  }
  if (path === "/api/download") {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="stress-report.txt"',
    });
    return res.end("Spana Stress Download Payload v1\n");
  }
  if (path === "/api/slow") {
    const ms = Math.min(Number(u.searchParams.get("ms") || 5000), 15000);
    const t = setTimeout(() => sendHtml(res, pageShell("Slow", "<p>done</p>")), ms);
    req.on("close", () => clearTimeout(t));
    return;
  }
  if (path === "/api/concurrency/reset") {
    concurrencyState.active = 0;
    concurrencyState.peak = 0;
    concurrencyState.totalEntered = 0;
    return sendJson(res, concurrencyState);
  }
  if (path === "/api/concurrency/enter") {
    concurrencyState.active += 1;
    concurrencyState.totalEntered += 1;
    if (concurrencyState.active > concurrencyState.peak) {
      concurrencyState.peak = concurrencyState.active;
    }
    return sendJson(res, concurrencyState);
  }
  if (path === "/api/concurrency/leave") {
    concurrencyState.active = Math.max(0, concurrencyState.active - 1);
    return sendJson(res, concurrencyState);
  }
  if (path === "/api/concurrency/stats") {
    return sendJson(res, concurrencyState);
  }
  if (path === "/wave2") {
    const srvUa = String(req.headers["user-agent"] || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;");
    return sendHtml(
      res,
      pageShell(
        "Wave 2 Regressions",
        `<style>
          .w2-spacer { height: 2200px; background: #f8fafc; }
          .w2-hidden { display: none; }
        </style>
        <div id="w2-ua" data-testid="w2-ua">${srvUa}</div>
        <button id="w2-async-en" data-testid="w2-async-en" disabled>Async Enable</button>
        <button id="w2-async-dis" data-testid="w2-async-dis">Async Disable</button>
        <fieldset disabled><button id="w2-fs-btn" data-testid="w2-fs-btn">FS Disabled</button></fieldset>
        <label>Upload <input id="w2-hidden-file" data-testid="w2-hidden-file" type="file" disabled class="w2-hidden" /></label>
        <canvas id="w2-canvas" width="32" height="32"></canvas>
        <div id="w2-nbsp" data-testid="w2-nbsp">4\u00a0200\u00a0000\u00a0kr</div>
        <div id="w2-nnbsp" data-testid="w2-nnbsp">9\u202f500\u202fkr</div>
        <iframe id="w2-sb-noscript" data-testid="w2-sb-noscript" sandbox="allow-same-origin" width="300" height="120"
          srcdoc="<!doctype html><html><body><h3 data-testid='w2-sb-h'>Sandboxed No-Scripts</h3><input id='w2-sb-input' data-testid='w2-sb-input' value='' /><div id='w2-sb-badge' data-testid='w2-sb-badge'>visible</div></body></html>"></iframe>
        <div>
          <label for="w2_lbl_in"><span>Lägg till en bild</span>: <span>beskriv bilden</span></label>
          <input id="w2_lbl_in" data-testid="w2-lbl-in" type="text" value="" />
        </div>
        <input id="w2-sv-in" data-testid="w2-sv-in" type="text" value="" />
        <div class="w2-spacer">Spacer</div>
        <button id="w2-off-fold-btn" data-testid="w2-off-fold-btn" aria-disabled="true"
          onclick="document.getElementById('w2-off-fold-out').textContent='forced-ok:' + Math.round(window.scrollY)">Off-Fold Force</button>
        <div id="w2-off-fold-out" data-testid="w2-off-fold-out">idle</div>
        <script>
          setTimeout(() => {
            document.getElementById('w2-async-en').disabled = false;
            document.getElementById('w2-async-dis').disabled = true;
          }, 80);
        </script>`,
      ),
    );
  }

  if (path === "/wave3-headers") {
    const srvUa = String(req.headers["user-agent"] || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;");
    const srvAl = String(req.headers["accept-language"] || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;");
    return sendHtml(
      res,
      pageShell(
        "Wave 3 Headers",
        `<main>
          <h1>Wave 3 Headers</h1>
          <div id="w3-ua" data-testid="w3-ua">${srvUa}</div>
          <div id="w3-al" data-testid="w3-al">${srvAl}</div>
        </main>`,
      ),
    );
  }

  if (path === "/wave3-basic-auth") {
    const expected = `Basic ${Buffer.from("stress:wave3").toString("base64")}`;
    if (req.headers.authorization !== expected) {
      return sendHtml(
        res,
        pageShell(
          "Auth Required",
          `<main><h1 data-testid="w3-auth-denied">Unauthorized</h1></main>`,
        ),
        401,
        { "www-authenticate": 'Basic realm="StressWave3"' },
      );
    }
    return sendHtml(
      res,
      pageShell("Auth Granted", `<main><h1 data-testid="w3-auth-ok">Wave 3 Authed</h1></main>`),
      200,
    );
  }

  if (path === "/wave3-status-404") {
    return sendHtml(
      res,
      pageShell("Wave 3 404", `<main><h1 data-testid="w3-404">Not Found 404</h1></main>`),
      404,
    );
  }

  if (path === "/wave3-redirect") {
    res.writeHead(302, { location: "/wave3" });
    res.end();
    return;
  }

  if (path === "/wave3") {
    return sendHtml(
      res,
      pageShell(
        "Wave 3 Polish & Bolagy Regressions",
        `<style>
          .w3-opacity-parent { opacity: 0; padding: 6px; }
          .w3-opacity-parent:hover, .w3-opacity-parent:focus-within { opacity: 1; }
          .w3-clip-shell { position: relative; width: 140px; height: 48px; overflow: hidden; border: 1px solid #9ca3af; }
          .w3-clip-btn { position: absolute; left: 70px; top: 4px; width: 240px; height: 36px; background: #2563eb; color: #fff; border: 0; }
          .w3-clip-blocker { position: absolute; left: 140px; top: 0; width: 220px; height: 56px; background: rgba(220,38,38,0.15); }
        </style>
        <main>
          <h1>Wave 3 Zero-Bug Lab</h1>
          <input type="checkbox" id="w3-vis-chk" data-testid="w3-vis-chk" checked aria-label="Visible Check" />
          <input type="checkbox" id="w3-hid-chk" data-testid="w3-hid-chk" data-meta="w3-secret" checked aria-label="Hidden Check" style="display:none" />

          <div class="w3-opacity-parent" data-testid="w3-opacity-parent">
            <button type="button" id="w3-opacity-btn" data-testid="w3-opacity-btn"
              onfocus="document.getElementById('w3-focus-out').textContent='focused-ok'">Reveal Menu Action</button>
          </div>
          <div id="w3-focus-out" data-testid="w3-focus-out">idle</div>

          <button type="button" id="w3-vat-btn" data-testid="w3-vat-btn"
            onclick="document.getElementById('w3-vat-out').textContent='vat-ok'">VAT return</button>
          <div id="w3-vat-out" data-testid="w3-vat-out">idle</div>

          <label for="w3-file-in">Upload Quarterly Receipt (PDF)</label>
          <input id="w3-file-in" data-testid="w3-file-in" type="file"
            onchange="document.getElementById('w3-file-out').textContent=this.files[0]?.name||'none'" />
          <div id="w3-file-out" data-testid="w3-file-out">none</div>

          <div style="position:relative; height:60px; margin-top:10px;">
            <div class="w3-clip-shell">
              <button type="button" class="w3-clip-btn" data-testid="w3-clip-btn"
                onclick="document.getElementById('w3-clip-out').textContent='clip-ok'">Clipped Action</button>
            </div>
            <div class="w3-clip-blocker"
              onclick="document.getElementById('w3-clip-out').textContent='blocker-hit'"></div>
          </div>
          <div id="w3-clip-out" data-testid="w3-clip-out">idle</div>

          <table>
            <caption>Accounting Summary</caption>
            <thead><tr><th>Account</th></tr></thead>
            <tbody><tr><td>1930</td></tr></tbody>
          </table>
          <figure>
            <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Balance Sheet" width="16" height="16" />
            <figcaption>Annual Balance Figure</figcaption>
          </figure>
          <meter value="0.8" min="0" max="1" aria-label="Quota Used">80%</meter>
          <output aria-label="Net Result">1200 kr</output>
          <label for="w3-sel">Region</label>
          <select id="w3-sel" data-testid="w3-sel">
            <option value="se">Sweden</option>
            <option value="dk">Denmark</option>
          </select>
          <button type="button" data-testid="w3-cors-trigger"
            onclick="(async()=>{const r=await fetch('https://w3-cors.spana.test/api/ping',{method:'POST',headers:{'Content-Type':'application/json','X-Stress':'1'},body:'{}'});const j=await r.json();document.getElementById('w3-cors-out').textContent='cors:'+j.pong;})()">Run CORS Fetch</button>
          <div id="w3-cors-out" data-testid="w3-cors-out">idle</div>
        </main>`,
      ),
    );
  }

  return sendHtml(
    res,
    pageShell("Spana Stress App", `<h1 data-testid="home-title">Stress Test Server Ready</h1>`),
  );
});

const concurrencyState = { active: 0, peak: 0, totalEntered: 0 };

const crossOriginServer = http.createServer((req, res) => {
  const u = new URL(req.url || "/", CROSS_ORIGIN);
  const path = u.pathname;
  if (path === "/oopif-child") {
    return sendHtml(
      res,
      pageShell(
        "OOPIF Static",
        `<button id="oopif-btn" data-testid="oopif-btn" onclick="document.getElementById('oopif-out').textContent='oopif-clicked'">OOPIF Button</button>
         <div id="oopif-out" data-testid="oopif-out">idle</div>`,
      ),
    );
  }
  if (path === "/oopif-dynamic") {
    return sendHtml(
      res,
      pageShell(
        "OOPIF Dynamic",
        `<button id="oopif-dyn-btn" data-testid="oopif-dyn-btn" onclick="document.getElementById('oopif-dyn-out').textContent='oopif-dyn-clicked'">Dynamic OOPIF Ready</button>
         <div id="oopif-dyn-out" data-testid="oopif-dyn-out">idle</div>`,
      ),
    );
  }
  if (path === "/oopif-scaled") {
    return sendHtml(
      res,
      pageShell(
        "OOPIF Scaled",
        `<button id="oopif-scaled-btn" data-testid="oopif-scaled-btn" style="margin-top:30px; margin-left:30px;" onclick="document.getElementById('oopif-scaled-out').textContent='oopif-scaled-clicked'">Scaled OOPIF Button</button>
         <div id="oopif-scaled-out" data-testid="oopif-scaled-out">idle</div>`,
      ),
    );
  }
  if (path === "/oopif-late") {
    return sendHtml(
      res,
      pageShell(
        "OOPIF Late",
        `<button id="oopif-late-btn" data-testid="oopif-late-btn" onclick="document.getElementById('oopif-late-out').textContent='oopif-late-clicked'">Late OOPIF Ready</button>
         <div id="oopif-late-out" data-testid="oopif-late-out">idle</div>`,
      ),
    );
  }
  return sendHtml(res, pageShell("OOPIF Root", "<p>Cross-Origin OK</p>"));
});

primaryServer.listen(PRIMARY_PORT, "127.0.0.1", () => {
  crossOriginServer.listen(CROSS_ORIGIN_PORT, "127.0.0.1", () => {
    console.log(`[stress-server] primary=${PRIMARY_ORIGIN} crossOrigin=${CROSS_ORIGIN}`);
  });
});

function shutdown() {
  primaryServer.close();
  crossOriginServer.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
