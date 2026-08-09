/* feed.codycarey.com — client logic: rendering, read tracking, search/filter. */
"use strict";

const READ_KEY = "na:read:v1";
const COLLAPSE_KEY = "na:collapsed:v1";
const NEWTAB_KEY = "na:newtab:v1";
const TITLE_LIMIT = 256;
const THEME_KEY = "na:theme:v1";
const REFRESH_MS = 10 * 60 * 1000;
const HISTORY_PAGE = 200;

const state = {
  latest: null,            // parsed latest.json
  archiveIndex: null,      // parsed archive/index.json
  months: new Map(),       // month key -> entries (loaded on demand)
  read: loadRead(),        // article id -> epoch seconds when read
  collapsed: loadCollapsed(), // Set of collapsed topic names
  newTab: localStorage.getItem(NEWTAB_KEY) === "1", // default: open in the same tab
  view: "latest",
  query: "",
  unreadOnly: false,
  historyShown: HISTORY_PAGE,
};

const $ = (sel) => document.querySelector(sel);

/* ---------- read-state store ---------- */

function loadRead() {
  try {
    return JSON.parse(localStorage.getItem(READ_KEY)) || {};
  } catch {
    return {};
  }
}

function saveRead() {
  localStorage.setItem(READ_KEY, JSON.stringify(state.read));
}

function markRead(id) {
  if (!state.read[id]) {
    state.read[id] = Math.floor(Date.now() / 1000);
    saveRead();
  }
}

/* ---------- collapsed-topics store ---------- */

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || []);
  } catch {
    return new Set();
  }
}

function saveCollapsed() {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...state.collapsed]));
}

function toggleCollapsed(topicName) {
  if (state.collapsed.has(topicName)) state.collapsed.delete(topicName);
  else state.collapsed.add(topicName);
  saveCollapsed();
  render(); // re-render nav too so the collapse/expand-all label stays accurate
}

function allTopicsCollapsed() {
  return state.latest.topics.every((topic) => state.collapsed.has(topic.name));
}

function setAllCollapsed(collapse) {
  state.collapsed = collapse
    ? new Set(state.latest.topics.map((topic) => topic.name))
    : new Set();
  saveCollapsed();
  render();
}

function expandTopic(topicName) {
  if (state.collapsed.has(topicName)) toggleCollapsed(topicName);
}

/* ---------- helpers ---------- */

function timeAgo(isoDate) {
  const secs = Math.max(0, (Date.now() - Date.parse(isoDate)) / 1000);
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 86400 * 30) return `${Math.floor(secs / 86400)}d`;
  return new Date(isoDate).toISOString().slice(0, 10);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function matchesQuery(entry, query) {
  if (!query) return true;
  const haystack = `${entry.title} ${entry.source} ${entry.summary || ""}`.toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

/* ---------- latest view ---------- */

function clampTitle(title) {
  if (title.length <= TITLE_LIMIT) return title;
  return `${title.slice(0, TITLE_LIMIT).replace(/\s+\S*$/, "")}…`;
}

function linkTarget() {
  // el() skips null attributes, so same-tab links get no target at all.
  return state.newTab ? "_blank" : null;
}

function articleLink(entry) {
  const link = el(
    "a",
    {
      class: "title",
      href: entry.url,
      target: linkTarget(),
      rel: "noopener",
      title: entry.summary || entry.title,
    },
    clampTitle(entry.title)
  );
  // Mark read on any click (left, middle, ctrl+click). The row restyles immediately.
  const onActivate = () => {
    markRead(entry.id);
    link.closest(".item, li")?.classList.add("read");
  };
  link.addEventListener("click", onActivate);
  link.addEventListener("auxclick", (ev) => { if (ev.button === 1) onActivate(); });
  return link;
}

function renderLatest() {
  const container = $("#view-latest");
  container.replaceChildren();
  if (!state.latest) return;

  for (const topic of state.latest.topics) {
    const grid = el("div", { class: "card-grid" });
    let topicVisible = 0;

    for (const feed of topic.feeds) {
      const items = feed.entries.filter(
        (entry) =>
          matchesQuery(entry, state.query) && !(state.unreadOnly && state.read[entry.id])
      );
      if (!items.length && (state.query || state.unreadOnly)) continue;
      topicVisible++;

      const list = el("ul");
      for (const entry of items) {
        list.append(
          el(
            "li",
            { class: `item${state.read[entry.id] ? " read" : ""}` },
            el("span", { class: "dot" }),
            articleLink(entry),
            el("span", { class: "age", title: entry.published }, timeAgo(entry.published))
          )
        );
      }
      if (!items.length) list.append(el("li", { class: "empty" }, "no articles"));

      const header = el(
        "h3",
        {},
        el("a", { href: feed.site || "#", target: linkTarget(), rel: "noopener" }, feed.name),
        feed.ok ? "" : el("span", { class: "feed-error", title: feed.error || "" }, "⚠ fetch failed"),
        el(
          "button",
          {
            class: "mark-read-btn",
            title: "Mark all shown articles as read",
            onclick: () => {
              feed.entries.forEach((entry) => markRead(entry.id));
              render();
            },
          },
          "✓ all"
        )
      );
      grid.append(el("div", { class: "feed-card" }, header, list));
    }

    if (topicVisible) {
      const anchor = topic.name.toLowerCase().replace(/\W+/g, "-");
      // An active search overrides collapse so matches are never hidden.
      const isCollapsed = state.collapsed.has(topic.name) && !state.query;
      const header = el(
        "h2",
        { onclick: () => toggleCollapsed(topic.name), title: "Collapse/expand this category" },
        el("span", { class: `chev${isCollapsed ? "" : " open"}` }, "▶"),
        topic.name,
        isCollapsed ? el("span", { class: "collapsed-note" }, `${topicVisible} feeds hidden`) : ""
      );
      const section = el(
        "section",
        { class: `topic-section${isCollapsed ? " collapsed" : ""}`, id: `topic-${anchor}` },
        header
      );
      if (!isCollapsed) section.append(grid);
      container.append(section);
    }
  }
}

function renderTopicNav() {
  const nav = $("#topic-nav");
  nav.replaceChildren();
  if (!state.latest || state.view !== "latest") return;
  for (const topic of state.latest.topics) {
    const anchor = topic.name.toLowerCase().replace(/\W+/g, "-");
    // Jumping to a collapsed section expands it first so the jump lands on content.
    nav.append(
      el("a", { href: `#topic-${anchor}`, onclick: () => expandTopic(topic.name) }, topic.name)
    );
  }
  const collapseAll = !allTopicsCollapsed();
  nav.append(
    el(
      "button",
      { class: "collapse-all-btn", onclick: () => setAllCollapsed(collapseAll) },
      collapseAll ? "collapse all" : "expand all"
    )
  );
}

/* ---------- history view ---------- */

async function ensureMonth(key) {
  if (state.months.has(key)) return;
  const resp = await fetch(`data/archive/${key}.json`);
  if (!resp.ok) throw new Error(`failed to load ${key}: ${resp.status}`);
  state.months.set(key, (await resp.json()).entries);
}

function selectedMonths() {
  return [...document.querySelectorAll("#month-list input:checked")].map((box) => box.value);
}

function renderMonthPicker() {
  const list = $("#month-list");
  list.replaceChildren();
  if (!state.archiveIndex) return;
  state.archiveIndex.months.forEach((info, i) => {
    const box = el("input", { type: "checkbox", value: info.month });
    box.checked = i === 0; // newest month pre-selected
    box.addEventListener("change", async () => {
      if (box.checked) await ensureMonth(info.month).catch(console.error);
      state.historyShown = HISTORY_PAGE;
      renderHistory();
    });
    list.append(el("label", {}, box, ` ${info.month} (${info.count})`));
  });
}

function populateHistoryFilters(entries) {
  const topicSel = $("#filter-topic");
  const sourceSel = $("#filter-source");
  const keepTopic = topicSel.value;
  const keepSource = sourceSel.value;
  const topics = [...new Set(entries.map((e) => e.topic))].sort();
  const sources = [...new Set(entries.map((e) => e.source))].sort();
  topicSel.replaceChildren(el("option", { value: "" }, "All topics"),
    ...topics.map((t) => el("option", { value: t }, t)));
  sourceSel.replaceChildren(el("option", { value: "" }, "All sources"),
    ...sources.map((s) => el("option", { value: s }, s)));
  topicSel.value = topics.includes(keepTopic) ? keepTopic : "";
  sourceSel.value = sources.includes(keepSource) ? keepSource : "";
}

function historyEntries() {
  const entries = [];
  for (const key of selectedMonths()) {
    entries.push(...(state.months.get(key) || []));
  }
  entries.sort((a, b) => b.published.localeCompare(a.published));
  return entries;
}

function renderHistory() {
  if (state.view !== "history") return;
  const all = historyEntries();
  populateHistoryFilters(all);

  const topicFilter = $("#filter-topic").value;
  const sourceFilter = $("#filter-source").value;
  const readFilter = $("#filter-read").value;
  const from = $("#filter-from").value; // yyyy-mm-dd, compares lexically with ISO dates
  const to = $("#filter-to").value;

  const filtered = all.filter((entry) => {
    if (!matchesQuery(entry, state.query)) return false;
    if (topicFilter && entry.topic !== topicFilter) return false;
    if (sourceFilter && entry.source !== sourceFilter) return false;
    if (readFilter === "read" && !state.read[entry.id]) return false;
    if (readFilter === "unread" && state.read[entry.id]) return false;
    if (state.unreadOnly && state.read[entry.id]) return false;
    if (from && entry.published.slice(0, 10) < from) return false;
    if (to && entry.published.slice(0, 10) > to) return false;
    return true;
  });

  $("#history-count").textContent =
    `${filtered.length.toLocaleString()} of ${all.length.toLocaleString()} articles match`;

  const list = $("#history-results");
  list.replaceChildren();
  for (const entry of filtered.slice(0, state.historyShown)) {
    const readAt = state.read[entry.id];
    list.append(
      el(
        "li",
        { class: readAt ? "read" : "" },
        articleLink(entry),
        el(
          "div",
          { class: "meta" },
          el("span", {}, entry.source),
          el("span", {}, entry.topic),
          el("span", { title: entry.published }, entry.published.slice(0, 16).replace("T", " ")),
          readAt ? el("span", {}, `read ${new Date(readAt * 1000).toISOString().slice(0, 10)}`) : ""
        ),
        entry.summary ? el("p", { class: "summary" }, entry.summary) : ""
      )
    );
  }
  $("#history-more").hidden = filtered.length <= state.historyShown;
}

/* ---------- view switching & controls ---------- */

function render() {
  renderTopicNav();
  if (state.view === "latest") renderLatest();
  else renderHistory();
}

async function switchView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  $("#view-latest").hidden = view !== "latest";
  $("#view-history").hidden = view !== "history";
  if (view === "history") {
    for (const key of selectedMonths()) await ensureMonth(key).catch(console.error);
  }
  render();
}

function applyTheme(mode) {
  if (mode === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  $("#theme-toggle").textContent = `Theme: ${mode}`;
}

function setupStickyTopicNav() {
  const nav = $("#topic-nav");
  const topbar = document.querySelector(".topbar");

  // The top bar wraps on narrow screens, so measure its real height and expose
  // it to CSS for the nav's sticky offset and the sections' scroll margin.
  const setTopbarHeight = () =>
    document.documentElement.style.setProperty("--topbar-h", `${topbar.offsetHeight}px`);
  new ResizeObserver(setTopbarHeight).observe(topbar);
  window.addEventListener("resize", setTopbarHeight);
  window.addEventListener("load", setTopbarHeight);
  setTopbarHeight();

  let lastY = window.scrollY;
  window.addEventListener(
    "scroll",
    () => {
      const y = window.scrollY;
      const dy = y - lastY;
      lastY = y;
      if (y <= nav.offsetHeight + topbar.offsetHeight) {
        nav.classList.remove("nav-hidden"); // at/near the top: always visible
      } else if (dy > 4) {
        nav.classList.add("nav-hidden");
      } else if (dy < -4) {
        nav.classList.remove("nav-hidden");
      }
    },
    { passive: true }
  );
}

function setupControls() {
  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => switchView(tab.dataset.view))
  );

  const search = $("#search");
  search.addEventListener("input", () => {
    state.query = search.value.trim().toLowerCase();
    state.historyShown = HISTORY_PAGE;
    render();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && document.activeElement !== search) {
      ev.preventDefault();
      search.focus();
    }
  });

  $("#unread-only").addEventListener("change", (ev) => {
    state.unreadOnly = ev.target.checked;
    render();
  });

  const newTabToggle = $("#newtab-toggle");
  newTabToggle.checked = state.newTab;
  newTabToggle.addEventListener("change", (ev) => {
    state.newTab = ev.target.checked;
    localStorage.setItem(NEWTAB_KEY, state.newTab ? "1" : "0");
    render(); // rebuild links with the new target
  });

  for (const id of ["filter-topic", "filter-source", "filter-read", "filter-from", "filter-to"]) {
    $(`#${id}`).addEventListener("change", () => {
      state.historyShown = HISTORY_PAGE;
      renderHistory();
    });
  }

  $("#history-more").addEventListener("click", () => {
    state.historyShown += HISTORY_PAGE;
    renderHistory();
  });

  const themes = ["auto", "dark", "light"];
  // Default to light: www.codycarey.com is a light-only design; dark stays available via the toggle.
  let themeIdx = Math.max(0, themes.indexOf(localStorage.getItem(THEME_KEY) || "light"));
  applyTheme(themes[themeIdx]);
  $("#theme-toggle").addEventListener("click", () => {
    themeIdx = (themeIdx + 1) % themes.length;
    localStorage.setItem(THEME_KEY, themes[themeIdx]);
    applyTheme(themes[themeIdx]);
  });

  $("#export-read").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.read, null, 1)], { type: "application/json" });
    const link = el("a", {
      href: URL.createObjectURL(blob),
      download: `read-history-${new Date().toISOString().slice(0, 10)}.json`,
    });
    link.click();
    URL.revokeObjectURL(link.href);
  });

  $("#import-read").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      Object.assign(state.read, imported); // merge, keeping both sides
      saveRead();
      render();
      alert(`Imported ${Object.keys(imported).length} read entries.`);
    } catch {
      alert("Import failed: not a valid read-history JSON file.");
    }
    ev.target.value = "";
  });

  $("#clear-read").addEventListener("click", () => {
    if (confirm("Clear all read history in this browser?")) {
      state.read = {};
      saveRead();
      render();
    }
  });
}

/* ---------- data loading ---------- */

async function loadData() {
  const [latestResp, indexResp] = await Promise.all([
    fetch("data/latest.json", { cache: "no-cache" }),
    fetch("data/archive/index.json", { cache: "no-cache" }),
  ]);
  if (latestResp.ok) state.latest = await latestResp.json();
  if (indexResp.ok) state.archiveIndex = await indexResp.json();

  if (state.latest) {
    const generated = new Date(state.latest.generated);
    $("#updated").textContent = `updated ${timeAgo(state.latest.generated)} ago`;
    $("#updated").title = generated.toLocaleString();
  }
}

async function init() {
  setupControls();
  setupStickyTopicNav();
  try {
    await loadData();
  } catch (err) {
    $("#view-latest").textContent = `Failed to load feed data: ${err}`;
    return;
  }
  renderMonthPicker();
  if (state.archiveIndex?.months.length) {
    await ensureMonth(state.archiveIndex.months[0].month).catch(console.error);
  }
  render();

  setInterval(async () => {
    await loadData().catch(() => {});
    render();
  }, REFRESH_MS);
}

init();
