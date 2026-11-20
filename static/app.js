(function () {
  "use strict";
  // Lazy-load game images: fetch the encrypted file, decrypt it, show it from an object URL.
  // An image that cannot be shown falls back to its data-fallback photo, else it is hidden.
  var mediaBase = (document.body.dataset.base || "/") + "media/";
  var observer = null;

  function onMediaFailure(img) {
    var fallback = img.getAttribute("data-fallback");
    if (fallback) {
      img.removeAttribute("data-fallback"); // a failing fallback must not loop
      img.src = fallback;
      return;
    }
    img.hidden = true;
    var slot = img.closest ? img.closest(".media-slot") : null;
    if (slot) { slot.hidden = true; }
  }

  function fetchBytes(url) {
    return fetch(url).then(function (response) {
      if (!response.ok) { throw new Error("missing"); }
      return response.arrayBuffer();
    });
  }

  // slug -> promise of an object URL: an image shown many times (a console logo on every
  // datasheet row) is fetched and decrypted once.
  var objectUrls = {};

  function objectUrl(slug) {
    if (!objectUrls[slug]) {
      objectUrls[slug] = fetchBytes(mediaBase + slug + ".enc")
        .then(function (buffer) { return window.museumDecryptBytes(new Uint8Array(buffer)); })
        .catch(function () {
          // A local build without a password publishes the plain file.
          return fetchBytes(mediaBase + slug + ".webp").then(function (buffer) {
            return new Uint8Array(buffer);
          });
        })
        .then(function (bytes) {
          return URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
        });
    }
    return objectUrls[slug];
  }

  function load(img) {
    img.onerror = function () { onMediaFailure(img); };
    objectUrl(img.getAttribute("data-media"))
      .then(function (url) { img.src = url; })
      .catch(function () { onMediaFailure(img); });
  }

  // Load every not-yet-handled img[data-media] under root (default: the document).
  window.museumLoadMedia = function (root) {
    var images = (root || document).querySelectorAll("img[data-media]");
    Array.prototype.forEach.call(images, function (img) {
      if (img.getAttribute("data-media-state")) { return; }
      img.setAttribute("data-media-state", "1");
      if ("IntersectionObserver" in window) {
        if (!observer) {
          observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
              if (entry.isIntersecting) { observer.unobserve(entry.target); load(entry.target); }
            });
          }, { rootMargin: "200px" });
        }
        observer.observe(img);
      } else {
        load(img);
      }
    });
  };
  window.museumLoadMedia();

  // url -> promise of the parsed JSON file published encrypted as url + ".enc" (the plain file
  // for a local build without a password); a failed load is tried again on the next call.
  var jsonFiles = {};
  window.museumLoadJson = function (url) {
    if (!jsonFiles[url]) {
      jsonFiles[url] = fetch(url + ".enc")
        .then(function (response) {
          if (!response.ok) { return fetch(url).then(function (r) { return r.json(); }); }
          return response.json().then(window.museumDecrypt).then(JSON.parse);
        })
        .catch(function (error) { delete jsonFiles[url]; throw error; });
    }
    return jsonFiles[url];
  };
})();
(function () {
  "use strict";
  var results = document.getElementById("results");
  var wall = document.getElementById("wall");
  if (!results || !wall) { return; }

  var base = document.body.dataset.base || "/";
  var FLAGS = { PAL: "\u{1F1EA}\u{1F1FA}", JP: "\u{1F1EF}\u{1F1F5}", US: "\u{1F1FA}\u{1F1F8}" };
  var search = document.getElementById("search");
  var selects = {
    region: document.getElementById("filter-region"),
    genre: document.getElementById("filter-genre"),
    condition: document.getElementById("filter-condition"),
    price: document.getElementById("filter-price")
  };
  var toggles = document.querySelectorAll(".view-toggle");
  var index = null;
  var loading = false;
  var money = new Intl.NumberFormat(
    document.documentElement.lang === "fr" ? "fr-FR" : "en-US",
    { style: "currency", currency: "EUR" }
  );

  function normalise(text) {
    return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  }

  function readHash() {
    var params = new URLSearchParams(location.hash.replace(/^#/, ""));
    var state = { q: params.get("q") || "" };
    Object.keys(selects).forEach(function (key) { state[key] = params.get(key) || ""; });
    return state;
  }

  function readControls() {
    var state = { q: search.value.trim() };
    Object.keys(selects).forEach(function (key) { state[key] = selects[key].value; });
    return state;
  }

  function writeControls(state) {
    search.value = state.q;
    Object.keys(selects).forEach(function (key) {
      selects[key].value = state[key];
      if (selects[key].value !== state[key]) { selects[key].value = ""; }
    });
  }

  function writeHash(state) {
    var params = new URLSearchParams();
    if (state.q) { params.set("q", state.q); }
    Object.keys(selects).forEach(function (key) {
      if (state[key]) { params.set(key, state[key]); }
    });
    var hash = params.toString();
    history.replaceState(null, "", location.pathname + location.search + (hash ? "#" + hash : ""));
  }

  function isActive(state) {
    return Boolean(state.q || state.region || state.genre || state.condition || state.price);
  }

  function inBucket(price, bucket) {
    if (bucket === "none") { return price === null; }
    if (price === null) { return false; }
    switch (bucket) {
      case "lt20": return price < 20;
      case "20-50": return price >= 20 && price < 50;
      case "50-100": return price >= 50 && price < 100;
      case "100-250": return price >= 100 && price < 250;
      case "250+": return price >= 250;
      default: return true;
    }
  }

  function matches(entry, state, words) {
    if (state.region && entry.region !== state.region) { return false; }
    if (state.genre && entry.genre !== state.genre) { return false; }
    if (state.condition && entry.condition !== state.condition) { return false; }
    if (state.price && !inBucket(entry.price_eur, state.price)) { return false; }
    return words.every(function (word) { return entry.text.indexOf(word) !== -1; });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function card(entry) {
    var a = el("a", "card");
    a.href = entry.url;
    if (typeof entry.alpha === "number") { a.style.setProperty("--alpha", String(entry.alpha)); }
    var cover = el("span", "cover");
    if (entry.cover || entry.image) {
      var img = document.createElement("img");
      if (entry.cover) {
        img.setAttribute("data-media", entry.cover);
        if (entry.image) { img.setAttribute("data-fallback", entry.image); }
      } else {
        img.src = entry.image;
      }
      img.alt = entry.title;
      img.loading = "lazy";
      cover.appendChild(img);
    }
    a.appendChild(cover);
    a.appendChild(el("span", "card-title", entry.title));
    var where = ((FLAGS[entry.region] || "") + " " + (entry.region_word || "")).trim();
    var meta = [where, entry.release].filter(Boolean).join(" \u00B7 ");
    a.appendChild(el("span", "card-meta", meta));
    a.appendChild(el("span", "card-condition", entry.condition_label || ""));
    var price = entry.price_eur === null ? "—" : money.format(entry.price_eur);
    a.appendChild(el("span", "card-price", price));
    return a;
  }

  function render(state) {
    var words = normalise(state.q).split(/\s+/).filter(Boolean);
    var shown = index.filter(function (entry) { return !entry.accessory && matches(entry, state, words); });
    results.replaceChildren();
    if (shown.length === 0) {
      results.appendChild(el("p", "no-results", results.dataset.noResults));
    }
    shown.forEach(function (entry) { results.appendChild(card(entry)); });
    if (window.museumApplySort) { window.museumApplySort(results); }
    window.museumLoadMedia(results);
  }

  function update(state) {
    writeHash(state);
    var active = isActive(state);
    wall.hidden = active;
    results.hidden = !active;
    Array.prototype.forEach.call(toggles, function (toggle) { toggle.hidden = !active; });
    if (!active) { return; }
    if (index) { render(state); return; }
    if (loading) { return; }
    loading = true;
    window.museumLoadJson(base + document.documentElement.lang + "/search.json")
      .then(function (data) {
        index = data;
        loading = false;
        render(readControls());
      })
      .catch(function () { loading = false; });
  }

  function onControl() { update(readControls()); }

  search.addEventListener("input", onControl);
  Object.keys(selects).forEach(function (key) { selects[key].addEventListener("change", onControl); });
  window.addEventListener("hashchange", function () {
    var state = readHash();
    writeControls(state);
    update(state);
  });

  var initial = readHash();
  writeControls(initial);
  update(initial);
})();
(function () {
  "use strict";
  // Theme switch: the inline head snippet applied the stored theme; this keeps a new choice.
  var select = document.getElementById("theme-switch");
  if (!select) { return; }
  var root = document.documentElement;
  select.value = root.dataset.theme;
  if (select.value !== root.dataset.theme) { select.selectedIndex = 0; }
  select.addEventListener("change", function () {
    root.dataset.theme = select.value;
    try { localStorage.setItem("museum-theme", select.value); } catch (e) { /* storage unavailable */ }
  });
})();
(function () {
  "use strict";
  // Tiles/list switch: the inline head snippet applied the stored view; this keeps a new choice.
  var buttons = document.querySelectorAll("[data-set-view]");
  if (!buttons.length) { return; }
  var root = document.documentElement;
  function show(view) {
    Array.prototype.forEach.call(buttons, function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-set-view") === view));
    });
  }
  show(root.dataset.view === "list" ? "list" : "tiles");
  Array.prototype.forEach.call(buttons, function (button) {
    button.addEventListener("click", function () {
      var view = button.getAttribute("data-set-view");
      root.dataset.view = view;
      show(view);
      try { localStorage.setItem("museum-view", view); } catch (e) { /* storage unavailable */ }
    });
  });
})();
(function () {
  "use strict";
  // Datasheet: one table of the collection, filtered and sorted in the browser. Rows are in
  // museum order (console, then date) in the page; filters and sort live in the address.
  var table = document.getElementById("datasheet");
  if (!table) { return; }
  var CONDITION_ORDER = ["loose", "loose_manual", "boxed", "complete", "new"];
  var REGION_ORDER = ["PAL", "JP", "US"];
  var SORT_KEYS = ["title", "console", "region", "date", "price", "score", "condition", "publisher", "developer"];

  function datasheetMatch(row, f) {
    if (f.q) {
      var words = f.q.split(/\s+/).filter(Boolean);
      for (var i = 0; i < words.length; i++) { if (row.text.indexOf(words[i]) < 0) { return false; } }
    }
    if (f.console && (f.console.indexOf(":") < 0 ? row.console : row.system) !== f.console) { return false; }
    if (f.condition && row.condition !== f.condition) { return false; }
    if (f.region && row.region !== f.region) { return false; }
    if ((f.ymin !== null || f.ymax !== null) && row.year === null) { return false; }
    if (f.ymin !== null && row.year < f.ymin) { return false; }
    if (f.ymax !== null && row.year > f.ymax) { return false; }
    if ((f.pmin !== null || f.pmax !== null) && row.price === null) { return false; }
    if (f.pmin !== null && row.price < f.pmin) { return false; }
    if (f.pmax !== null && row.price > f.pmax) { return false; }
    return true;
  }

  function datasheetCompare(a, b, key, dir) {
    var x, y;
    if (key === "console") { x = a.consolePos; y = b.consolePos; }
    else if (key === "price") { x = a.price; y = b.price; }
    else if (key === "score") { x = a.score; y = b.score; }
    else if (key === "region") { x = REGION_ORDER.indexOf(a.region); y = REGION_ORDER.indexOf(b.region); }
    else if (key === "condition") { x = CONDITION_ORDER.indexOf(a.condition); y = CONDITION_ORDER.indexOf(b.condition); }
    else { x = a[key] || null; y = b[key] || null; }
    if (x === null && y !== null) { return 1; }   // missing values always last
    if (y === null && x !== null) { return -1; }
    if (x !== null && y !== null && x !== y) {
      var c = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
      if (c) { return c * dir; }
    }
    return a.pos - b.pos;
  }

  function fold(text) {
    return String(text || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  }
  function num(value) { return value === "" || value === undefined || value === null || isNaN(Number(value)) ? null : Number(value); }

  var tbody = table.tBodies[0];
  var rows = Array.prototype.map.call(tbody.rows, function (tr) {
    var d = tr.dataset;
    return { tr: tr, pos: Number(d.pos), consolePos: Number(d.consolePos), console: d.console, system: d.system,
             condition: d.condition, region: d.region, year: num(d.year), price: num(d.price), score: num(d.score),
             date: d.date || null, title: d.title || null, publisher: d.publisher || null,
             developer: d.developer || null, text: d.text || "" };
  });
  var controls = {
    q: document.getElementById("ds-search"), console: document.getElementById("ds-console"),
    condition: document.getElementById("ds-condition"), region: document.getElementById("ds-region"),
    ymin: document.getElementById("ds-year-min"), ymax: document.getElementById("ds-year-max"),
    pmin: document.getElementById("ds-price-min"), pmax: document.getElementById("ds-price-max")
  };
  var count = document.getElementById("ds-count");
  var none = document.getElementById("ds-none");
  var headers = table.querySelectorAll("[data-sort-key]");
  var state = { sort: "", dir: 1 };

  function readHash() {
    var params = new URLSearchParams(location.hash.slice(1));
    Object.keys(controls).forEach(function (k) { if (params.has(k)) { controls[k].value = params.get(k); } });
    var sort = params.get("sort") || "";
    state.sort = SORT_KEYS.indexOf(sort) > -1 ? sort : "";
    state.dir = params.get("dir") === "-1" ? -1 : 1;
  }
  function writeHash() {
    var params = new URLSearchParams();
    Object.keys(controls).forEach(function (k) { if (controls[k].value) { params.set(k, controls[k].value); } });
    if (state.sort) { params.set("sort", state.sort); params.set("dir", String(state.dir)); }
    var hash = params.toString();
    try { history.replaceState(null, "", hash ? "#" + hash : location.pathname); } catch (e) { /* rate-limited */ }
  }
  function update() {
    var f = { q: fold(controls.q.value).trim(), console: controls.console.value,
              condition: controls.condition.value, region: controls.region.value,
              ymin: num(controls.ymin.value), ymax: num(controls.ymax.value),
              pmin: num(controls.pmin.value), pmax: num(controls.pmax.value) };
    var ordered = state.sort ? rows.slice().sort(function (a, b) { return datasheetCompare(a, b, state.sort, state.dir); })
                             : rows.slice().sort(function (a, b) { return a.pos - b.pos; });
    var shown = 0;
    ordered.forEach(function (row) {
      var ok = datasheetMatch(row, f);
      row.tr.hidden = !ok;
      if (ok) { shown += 1; }
      tbody.appendChild(row.tr);
    });
    count.textContent = (shown === 1 ? count.dataset.one : count.dataset.many).replace("{n}", String(shown));
    none.hidden = shown !== 0;
    Array.prototype.forEach.call(headers, function (button) {
      var key = button.getAttribute("data-sort-key");
      button.parentNode.setAttribute("aria-sort",
        key === state.sort ? (state.dir === 1 ? "ascending" : "descending") : "none");
    });
    writeHash();
  }
  Array.prototype.forEach.call(headers, function (button) {
    button.addEventListener("click", function () {
      var key = button.getAttribute("data-sort-key");
      state.dir = state.sort === key ? -state.dir : 1;
      state.sort = key;
      update();
    });
  });
  Object.keys(controls).forEach(function (k) { controls[k].addEventListener("input", update); });
  document.getElementById("ds-reset").addEventListener("click", function () {
    setTimeout(function () { state.sort = ""; state.dir = 1; update(); }, 0);
  });
  tbody.addEventListener("click", function (event) {
    if (event.target.closest("a")) { return; }
    if (window.getSelection && String(window.getSelection()).length) { return; }  // selecting text
    var link = event.target.closest("tr") && event.target.closest("tr").querySelector("a[href]");
    if (!link) { return; }
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) {
      window.open(link.href, "_blank");
    } else {
      location.href = link.href;
    }
  });
  readHash();
  update();
})();
(function () {
  "use strict";
  // Date / A–Z switch: the inline head snippet applied the stored order; this keeps a new choice.
  var buttons = document.querySelectorAll("[data-set-sort]");
  if (!buttons.length) { return; }
  var root = document.documentElement;
  function show(sort) {
    Array.prototype.forEach.call(buttons, function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-set-sort") === sort));
    });
  }
  function sortOrder(items, sort) {
    return items.slice().sort(function (a, b) {
      return sort === "alpha" ? a.alpha - b.alpha : a.pos - b.pos;
    });
  }
  // Reorder the cards in the page itself (not only on screen), so Tab and screen readers
  // follow the order that is shown. Each card's original (date) position is kept.
  function apply(scope) {
    var sort = root.dataset.sort === "date" ? "date" : "alpha";
    var grids = (scope || document).querySelectorAll(".grid:not(#wall)");
    if (scope && scope.matches && scope.matches(".grid:not(#wall)")) { grids = [scope]; }
    Array.prototype.forEach.call(grids, function (grid) {
      // A console card the owner can change the photo of is wrapped (with its button) in a
      // .photo-tile by photos.js: the wrapper moves, sorted by its card.
      var items = Array.prototype.filter.call(grid.children, function (c) {
        return c.classList.contains("card") || c.classList.contains("photo-tile");
      }).map(function (child, i) {
        var card = child.classList.contains("card") ? child : child.querySelector(".card");
        if (!card.hasAttribute("data-pos")) { card.setAttribute("data-pos", String(i)); }
        return { card: child, pos: Number(card.getAttribute("data-pos")),
                 alpha: Number(card.style.getPropertyValue("--alpha")) || 0 };
      });
      sortOrder(items, sort).forEach(function (item) { grid.appendChild(item.card); });
    });
  }
  window.museumApplySort = apply;
  show(root.dataset.sort === "date" ? "date" : "alpha");
  apply();
  Array.prototype.forEach.call(buttons, function (button) {
    button.addEventListener("click", function () {
      var sort = button.getAttribute("data-set-sort");
      root.dataset.sort = sort;
      show(sort);
      apply();
      try { localStorage.setItem("museum-sort", sort); } catch (e) { /* storage unavailable */ }
    });
  });
})();
(function () {
  "use strict";
  // Screens carousel on game pages: a scroll-snap track (swiping works without the script),
  // with previous/next buttons, arrow keys and a "1 / 3" counter. Slides whose image could
  // not be shown are hidden by the media loader and left out; no slide hides the carousel.
  function carouselStep(count, index, dir) {
    if (count < 1) { return 0; }
    return (((index % count) + dir) % count + count) % count;
  }

  Array.prototype.forEach.call(document.querySelectorAll(".carousel"), function (carousel) {
    var track = carousel.querySelector(".carousel-track");
    var counter = carousel.querySelector(".carousel-count");
    if (!track) { return; }
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function slides() {
      return Array.prototype.filter.call(track.children, function (s) { return !s.hidden; });
    }
    function current(list) {
      var best = 0, distance = Infinity;
      list.forEach(function (slide, i) {
        var d = Math.abs(slide.offsetLeft - track.scrollLeft);
        if (d < distance) { distance = d; best = i; }
      });
      return best;
    }
    function update() {
      var list = slides();
      carousel.hidden = list.length === 0;
      if (list.length < 2) { carousel.setAttribute("data-single", ""); }
      else { carousel.removeAttribute("data-single"); }
      if (counter) { counter.textContent = (list.length ? current(list) + 1 : 0) + " / " + list.length; }
    }
    function go(dir) {
      var list = slides();
      if (list.length < 2) { return; }
      var target = list[carouselStep(list.length, current(list), dir)];
      track.scrollTo({ left: target.offsetLeft, behavior: reduce ? "auto" : "smooth" });
    }

    var prev = carousel.querySelector(".carousel-prev");
    var next = carousel.querySelector(".carousel-next");
    if (prev) { prev.addEventListener("click", function () { go(-1); }); }
    if (next) { next.addEventListener("click", function () { go(1); }); }
    track.addEventListener("keydown", function (event) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        go(event.key === "ArrowLeft" ? -1 : 1);
      }
    });
    var pending = false;
    track.addEventListener("scroll", function () {
      if (pending) { return; }
      pending = true;
      requestAnimationFrame(function () { pending = false; update(); });
    }, { passive: true });
    if ("MutationObserver" in window) {
      new MutationObserver(update).observe(track, { attributes: true, subtree: true, attributeFilter: ["hidden"] });
    }
    window.addEventListener("resize", update);
    update();
  });
})();
