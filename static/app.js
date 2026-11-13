(function () {
  "use strict";
  // Lazy-load game images: fetch the encrypted file, decrypt it, show it from an object URL.
  var images = document.querySelectorAll("img[data-media]");
  if (images.length) {
    var mediaBase = (document.body.dataset.base || "/") + "media/";
    var fail = function (img) {
      img.hidden = true;
      var slot = img.closest ? img.closest(".media-slot") : null;
      if (slot) { slot.hidden = true; }
    };
    var fetchBytes = function (url) {
      return fetch(url).then(function (response) {
        if (!response.ok) { throw new Error("missing"); }
        return response.arrayBuffer();
      });
    };
    var load = function (img) {
      var slug = img.getAttribute("data-media");
      img.onerror = function () { fail(img); };
      fetchBytes(mediaBase + slug + ".enc")
        .then(function (buffer) { return window.museumDecryptBytes(new Uint8Array(buffer)); })
        .catch(function () {
          // A local build without a password publishes the plain file.
          return fetchBytes(mediaBase + slug + ".webp").then(function (buffer) {
            return new Uint8Array(buffer);
          });
        })
        .then(function (bytes) {
          img.src = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
        })
        .catch(function () { fail(img); });
    };
    if ("IntersectionObserver" in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { observer.unobserve(entry.target); load(entry.target); }
        });
      }, { rootMargin: "200px" });
      Array.prototype.forEach.call(images, function (img) { observer.observe(img); });
    } else {
      Array.prototype.forEach.call(images, load);
    }
  }

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
    var cover = el("span", "cover");
    if (entry.image) {
      var img = document.createElement("img");
      img.src = entry.image;
      img.alt = entry.title;
      img.loading = "lazy";
      cover.appendChild(img);
    }
    var flag = el("span", "flag", FLAGS[entry.region] || "");
    var option = selects.region && selects.region.querySelector('option[value="' + entry.region + '"]');
    if (option) { flag.title = option.textContent.replace(/^\S+\s/, ""); }
    cover.appendChild(flag);
    a.appendChild(cover);
    a.appendChild(el("span", "card-title", entry.title));
    var price = entry.price_eur === null ? "—" : money.format(entry.price_eur);
    a.appendChild(el("span", "card-price", price));
    return a;
  }

  function render(state) {
    var words = normalise(state.q).split(/\s+/).filter(Boolean);
    var shown = index.filter(function (entry) { return matches(entry, state, words); });
    results.replaceChildren();
    if (shown.length === 0) {
      results.appendChild(el("p", "no-results", results.dataset.noResults));
    }
    shown.forEach(function (entry) { results.appendChild(card(entry)); });
  }

  function update(state) {
    writeHash(state);
    var active = isActive(state);
    wall.hidden = active;
    results.hidden = !active;
    if (!active) { return; }
    if (index) { render(state); return; }
    if (loading) { return; }
    loading = true;
    var url = base + document.documentElement.lang + "/search.json";
    fetch(url + ".enc")
      .then(function (response) {
        if (!response.ok) { return fetch(url).then(function (r) { return r.json(); }); }
        return response.json().then(window.museumDecrypt).then(JSON.parse);
      })
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
