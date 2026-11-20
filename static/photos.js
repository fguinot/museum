(function (root) {
  "use strict";
  // The owner's console photos: pick a photo for an owned console from Wikimedia Commons or
  // upload one, and save it to data/console-photos/<offer>.jpg plus the index
  // data/console-photos.json. This file holds the pure logic; the page part comes after it.

  var MAX_CREDIT = 300;
  var PENDING_MS = 3600000; // a saved photo is shown over the built page for at most an hour
  var COMMONS_API = "https://commons.wikimedia.org/w/api.php";
  var MIMES = ["image/jpeg", "image/png", "image/webp"];
  var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

  // The photos file with this offer's entry set (`entry` = {source, credit, page}, stamped
  // with `updated`) or removed (`entry` null). Other offers are untouched.
  function photosMergeEntry(file, offerId, entry, nowIso) {
    var out = file ? JSON.parse(JSON.stringify(file)) : { version: 1, photos: {} };
    if (!out.photos || typeof out.photos !== "object") { out.photos = {}; }
    if (entry) {
      out.photos[offerId] = {
        source: entry.source,
        credit: entry.credit === undefined ? null : entry.credit,
        page: entry.page === undefined ? null : entry.page,
        updated: nowIso
      };
    } else {
      delete out.photos[offerId];
    }
    return out;
  }

  // Commons' HTML author/licence text as one plain line of at most 300 characters, or null.
  function photosPlainCredit(html) {
    if (html === null || html === undefined) { return null; }
    var text = String(html).replace(/<[^>]*>/g, "")
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (match, name) {
        if (name.charAt(0) === "#") {
          var code = name.charAt(1).toLowerCase() === "x" ? parseInt(name.slice(2), 16)
                                                         : parseInt(name.slice(1), 10);
          try { return String.fromCodePoint(code); } catch (e) { return match; }
        }
        var known = ENTITIES[name.toLowerCase()];
        return known === undefined ? match : known;
      })
      .replace(/\s+/g, " ").trim();
    if (text.length > MAX_CREDIT) { text = text.slice(0, MAX_CREDIT).trim(); }
    return text || null;
  }

  function metaValue(meta, key) {
    return meta && meta[key] && typeof meta[key].value === "string" ? meta[key].value : null;
  }

  function resultFrom(page) {
    var info = page.imageinfo && page.imageinfo[0];
    if (!info || MIMES.indexOf(info.mime) < 0 || !info.thumburl) { return null; }
    var url = info.thumburl;
    // The 1200 px thumbnail address rewritten to Wikimedia's standard 330 px width; when the
    // original is smaller, thumburl is the original itself and serves both.
    var thumb = url.replace(/\/1200px-([^\/]*)$/, "/330px-$1");
    var author = photosPlainCredit(metaValue(info.extmetadata, "Artist"));
    var licence = photosPlainCredit(metaValue(info.extmetadata, "LicenseShortName"));
    var credit = photosPlainCredit([author, licence].filter(Boolean).join(", "));
    return { title: page.title, page: info.descriptionurl, thumb: thumb, url: url,
             credit: credit };
  }

  // Bitmap files of Wikimedia Commons matching `text`, in search order; rejects when Commons
  // cannot be reached or answers an error.
  function photosCommonsSearch(fetchFn, text) {
    var params = new URLSearchParams({
      action: "query", generator: "search", gsrnamespace: "6",
      gsrsearch: text + " filetype:bitmap", gsrlimit: "20", prop: "imageinfo",
      iiprop: "url|mime|extmetadata", iiurlwidth: "1200", format: "json", origin: "*"
    });
    return Promise.resolve().then(function () { return fetchFn(COMMONS_API + "?" + params.toString()); })
      .then(function (response) {
        if (!response.ok) { throw new Error("commons " + response.status); }
        return response.json();
      })
      .then(function (body) {
        var pages = body && body.query && body.query.pages ? body.query.pages : {};
        return Object.keys(pages).map(function (id) { return pages[id]; })
          .sort(function (a, b) { return (a.index || 0) - (b.index || 0); })
          .map(resultFrom).filter(Boolean);
      });
  }

  // {width, height} of an image scaled down (never up) so that its longest side is at most `max`.
  function photosFitSize(width, height, max) {
    var scale = Math.min(1, max / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)),
             height: Math.max(1, Math.round(height * scale)) };
  }

  // What this browser saved for `offerId` in the last hour, to show over the built page:
  // {source, credit, page, updated, image} for a photo, {removed: true} for a removal, null when
  // there is nothing to show or the built page already matches. `pending` maps offer ids to
  // {savedAt, removed} or {savedAt, source, credit, page, updated, image} (`updated` is the stamp written to
  // the index); `built` is the built page's {source, credit, page, updated}, or null when it shows no chosen photo.
  function photosPendingFor(pending, offerId, built, nowMs) {
    var entry = pending && pending[offerId];
    if (!entry || typeof entry.savedAt !== "number") { return null; }
    if (nowMs - entry.savedAt > PENDING_MS) { return null; }
    if (entry.removed) { return built ? { removed: true } : null; }
    if (built && entry.updated && built.updated === entry.updated) { return null; }
    return { source: entry.source, credit: entry.credit === undefined ? null : entry.credit,
             page: entry.page === undefined ? null : entry.page, updated: entry.updated,
             image: entry.image };
  }

  var api = {
    photosMergeEntry: photosMergeEntry,
    photosPlainCredit: photosPlainCredit,
    photosCommonsSearch: photosCommonsSearch,
    photosPendingFor: photosPendingFor,
    photosFitSize: photosFitSize
  };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.museumPhotos = api;
  if (typeof document === "undefined") { return; }

  // --- The page: console tiles (console pages) and the big cover (a console's item page) ---
  // Pages built without a notes target carry no #photos-data block, so nothing here runs for
  // them. A photo saved from this browser is shown over the built page for an hour; the change
  // button only appears in a browser holding the owner's token.

  var TOKEN_KEY = "museum-github-token";
  var PENDING_KEY = "museum-photos-pending";
  var SAVE_SIDE = 1200;       // the image committed to the repository
  var SAVE_QUALITY = 0.85;
  var PENDING_SIDE = 300;     // an uploaded photo kept in this browser until the site is rebuilt
  var PENDING_QUALITY = 0.8;
  var SEARCH_DELAY = 350;
  var notes = root.museumNotes;

  function readStore(key) {
    try { return root.localStorage.getItem(key); } catch (e) { return null; }
  }

  function readPending() {
    try {
      var all = JSON.parse(root.localStorage.getItem(PENDING_KEY));
      return all && typeof all === "object" ? all : {};
    } catch (e) { return {}; }
  }

  function writePending(all) {
    try {
      if (Object.keys(all).length) { root.localStorage.setItem(PENDING_KEY, JSON.stringify(all)); }
      else { root.localStorage.removeItem(PENDING_KEY); }
    } catch (e) { /* storage unavailable or full: the page shows the photo until reloaded */ }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function format(text, values) {
    return text.replace(/\{(\w+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
    });
  }

  function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }

  function loadImage(src, anonymous) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      if (anonymous) { img.crossOrigin = "anonymous"; img.referrerPolicy = "no-referrer"; }
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("load")); };
      img.src = src;
    });
  }

  // {image, done} for an uploaded file: an ImageBitmap where the browser can make one, else a
  // loaded <img>; rejects when the browser cannot read the file (a HEIC photo on most desktops).
  function decodeFile(file) {
    function viaImage() {
      var url = URL.createObjectURL(file);
      return loadImage(url).then(function (img) {
        return { image: img, done: function () { URL.revokeObjectURL(url); } };
      }, function (error) { URL.revokeObjectURL(url); throw error; });
    }
    if (typeof root.createImageBitmap !== "function") { return viaImage(); }
    return root.createImageBitmap(file).then(function (bitmap) {
      return { image: bitmap, done: function () { if (bitmap.close) { bitmap.close(); } } };
    }, viaImage);
  }

  // The image drawn on a white canvas (JPEG has no transparency), longest side at most `side`.
  function canvasOf(image, side) {
    var w = image.naturalWidth || image.width, h = image.naturalHeight || image.height;
    if (!w || !h) { throw new Error("size"); }
    var size = photosFitSize(w, h, side);
    var canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    var context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    return canvas;
  }

  function jpegBlob(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) { resolve(blob); } else { reject(new Error("encode")); }
      }, "image/jpeg", quality);
    });
  }

  function base64Of(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(",")[1]); };
      reader.onerror = function () { reject(new Error("read")); };
      reader.readAsDataURL(blob);
    });
  }

  // The PriceCharting photo of a cover as built: its data-fallback, or its src when the page
  // shows that photo directly; null when there is none.
  function fallbackOf(img) {
    if (!img) { return null; }
    return img.getAttribute("data-fallback")
      || (img.hasAttribute("data-media") ? null : img.getAttribute("src"));
  }

  // A fresh <img> in place of `old` (which app.js may still be decrypting into), or appended to
  // `holder` when there was none; it keeps the built cover's PriceCharting photo for showRemoved.
  function putImage(old, holder, src, alt, className, fallback) {
    var img = el("img", className || "");
    img.alt = alt;
    img.src = src;
    if (fallback) { img.setAttribute("data-fallback", fallback); }
    if (old && old.parentNode) { old.parentNode.replaceChild(img, old); }
    else if (holder) { holder.appendChild(img); }
    return img;
  }

  // What the cover shows without the removed photo until the site is rebuilt: the
  // PriceCharting photo when the page has one, else the empty cover box.
  function showRemoved(img) {
    if (!img) { return img; }
    var fallback = img.getAttribute("data-fallback");
    if (!fallback) { img.hidden = true; return img; }
    return putImage(img, null, fallback, img.alt, img.className, fallback);
  }

  // The pending entries younger than an hour, the others forgotten.
  function freshPending(now) {
    var pending = readPending();
    Object.keys(pending).forEach(function (offer) {
      var entry = pending[offer];
      if (!entry || typeof entry.savedAt !== "number" || now - entry.savedAt > PENDING_MS) {
        delete pending[offer];
      }
    });
    return pending;
  }

  // A console's own page: its big cover and the Commons credit under it, showing a photo saved
  // or removed in the last hour until the site is rebuilt; the owner's change button below.
  function showOnItem(data, shown) {
    var img = document.querySelector(".covers .big-cover");
    var caption = document.querySelector(".covers .photo-credit");
    if (shown.removed) {
      showRemoved(img);
      if (caption) { caption.hidden = true; }
      return;
    }
    var covers = document.querySelector(".covers");
    if (!img && !covers) { return; }
    img = putImage(img, img ? null : covers, shown.image, img ? img.alt : "", "big-cover", fallbackOf(img));
    img.hidden = false;
    if (shown.source !== "commons" || !shown.credit) {
      if (caption) { caption.hidden = true; }
      return;
    }
    if (!caption) {
      var figure = el("figure", "photo-slot");
      img.parentNode.insertBefore(figure, img);
      figure.appendChild(img);
      caption = el("figcaption", "photo-credit");
      figure.appendChild(caption);
    }
    caption.hidden = false;
    caption.textContent = format(data.strings.photo_credit, { credit: shown.credit });
  }

  function initItem(data, item) {
    var now = Date.now();
    var pending = freshPending(now);
    var overlay = photosPendingFor(pending, item.offer, item.built, now);
    if (!overlay) { delete pending[item.offer]; }
    writePending(pending);
    var state = { hasPhoto: !!item.built };
    if (overlay) {
      showOnItem(data, overlay);
      state.hasPhoto = !overlay.removed;
    }
    if (readStore(TOKEN_KEY)) { addItemEditor(data, item, state); }
  }

  function addItemEditor(data, item, state) {
    var t = data.strings;
    var buildPanel = panelKit(data);
    var box = el("div", "photo-editor");
    var button = el("button", "photo-change", t.photo_change);
    button.type = "button";
    var message = el("p", "notes-message photo-message");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    box.appendChild(button);
    box.appendChild(message);
    // under the covers when the page has some, else at the top of the page's text
    var covers = document.querySelector(".exhibit-media") || document.querySelector(".covers");
    if (covers) { covers.appendChild(box); }
    else {
      var meta = document.querySelector(".exhibit .meta");
      if (!meta) { return; }
      meta.insertBefore(box, meta.firstChild);
    }

    function say(text, isError) {
      message.textContent = text;
      message.classList.toggle("notes-error", !!isError);
    }

    button.addEventListener("click", function () {
      say("");
      var panel = buildPanel(item, state, say, function (saved) {
        if (saved) {
          if (saved.removed) {
            showOnItem(data, { removed: true });
          } else {
            var entry = readPending()[item.offer] || {};
            showOnItem(data, { image: saved.src, source: entry.source, credit: entry.credit });
          }
          state.hasPhoto = !saved.removed;
        }
        panel.close();
        button.hidden = false;
        button.focus();
        if (saved) { say(t.notes_saved); }
      });
      button.hidden = true;
      box.insertBefore(panel.form, message);
      panel.focus();
    });
  }

  // A console page: each console tile shows the photo the owner just saved or removed (from
  // the console's own page) until the site is rebuilt. Changing photos happens on each
  // console's own page.
  function initShelf(data) {
    var now = Date.now();
    var pending = freshPending(now);
    var cards = document.querySelectorAll(".centrepieces a.card");
    data.consoles.forEach(function (item) {
      var card = Array.prototype.filter.call(cards, function (a) {
        return a.getAttribute("href") === item.href;
      })[0];
      if (!card) { return; }
      var cover = card.querySelector(".cover");
      var built = cover.querySelector("img");
      var overlay = photosPendingFor(pending, item.offer, item.built, now);
      if (!overlay) {
        delete pending[item.offer];
      } else if (overlay.removed) {
        showRemoved(built);
      } else {
        putImage(built, cover, overlay.image, built ? built.alt : item.title, "", fallbackOf(built));
      }
    });
    writePending(pending);
  }

  // The owner's photo panel of one console (its own page): Commons search, upload, preview,
  // Save / Cancel / Remove.
  function panelKit(data) {
    var t = data.strings;
    var fetchFn = root.fetch.bind(root);

    function errorText(result) {
      if (result.error === "unreadable") { return t.photo_unreadable; }
      if (result.error === "other" || !t["notes_error_" + result.error]) {
        return format(t.notes_error_other, { code: result.code === undefined ? "?" : result.code });
      }
      return t["notes_error_" + result.error];
    }

    function storePending(offer, entry) {
      var all = readPending();
      all[offer] = entry;
      writePending(all);
    }

    // The panel of one console: Commons search, upload, preview, Save / Cancel / Remove.
    // `done(saved)` closes it: saved = {src} after a save, {removed: true} after a removal,
    // undefined on Cancel.
    function buildPanel(item, state, say, done) {
      var choice = null;   // {kind: "commons", result} or {kind: "own", blob, small}
      var previewUrl = null;
      var form = el("form", "photo-panel");
      form.appendChild(el("p", "photo-copy", t.photo_your_copy + " " + item.condition_label));

      var query = el("input", "photo-search");
      query.type = "search";
      query.placeholder = t.photo_search;
      query.setAttribute("aria-label", t.photo_search);
      query.value = item.title;
      var results = el("ul", "photo-results");
      var note = el("p", "photo-note");
      form.appendChild(query);
      form.appendChild(results);
      form.appendChild(note);

      var upload = el("label", "photo-upload");
      upload.appendChild(el("span", "", t.photo_upload));
      var file = el("input");
      file.type = "file";
      file.accept = "image/*";
      upload.appendChild(file);
      form.appendChild(upload);

      var preview = el("img", "photo-preview");
      preview.alt = "";
      preview.hidden = true;
      form.appendChild(preview);

      var buttons = el("div", "notes-buttons");
      var save = el("button", "notes-save", t.notes_save);
      save.type = "submit";
      save.disabled = true;
      var cancel = el("button", "notes-cancel", t.notes_cancel);
      cancel.type = "button";
      buttons.appendChild(save);
      buttons.appendChild(cancel);
      var remove = null;
      if (state.hasPhoto) {
        remove = el("button", "photo-remove", t.photo_remove);
        remove.type = "button";
        buttons.appendChild(remove);
      }
      form.appendChild(buttons);

      function busy(on) {
        save.disabled = on || !choice;
        cancel.disabled = on;
        file.disabled = on;
        if (remove) { remove.disabled = on; }
      }

      function setPreview(src) {
        preview.src = src;
        preview.alt = t.photo_your_copy + " " + item.title;
        preview.hidden = false;
      }

      function select(next) {
        choice = next;
        Array.prototype.forEach.call(results.querySelectorAll("button"), function (b) {
          b.setAttribute("aria-pressed", String(next.kind === "commons" && b.photoResult === next.result));
        });
        busy(false);
      }

      var searchRun = 0;
      var searchTimer = null;

      function search(text) {
        var run = ++searchRun;
        photosCommonsSearch(fetchFn, text).then(function (found) {
          if (run !== searchRun) { return; }
          results.replaceChildren();
          note.textContent = found.length ? "" : t.photo_none_found;
          found.forEach(function (result) {
            var li = el("li");
            var pick = el("button", "photo-result");
            pick.type = "button";
            pick.photoResult = result;
            pick.setAttribute("aria-pressed", "false");
            var img = el("img");
            img.src = result.thumb;
            img.alt = result.title.replace(/^File:/, "");
            img.loading = "lazy";
            img.referrerPolicy = "no-referrer";
            pick.appendChild(img);
            pick.addEventListener("click", function () {
              setPreview(result.thumb);
              select({ kind: "commons", result: result });
            });
            li.appendChild(pick);
            results.appendChild(li);
          });
        }, function () {
          if (run !== searchRun) { return; }
          results.replaceChildren();
          note.textContent = t.notes_error_network;
        });
      }

      function schedule() {
        var text = query.value.trim();
        searchRun++;
        clearTimeout(searchTimer);
        if (text.length < 2) { results.replaceChildren(); note.textContent = ""; return; }
        searchTimer = setTimeout(function () { search(text); }, SEARCH_DELAY);
      }
      query.addEventListener("input", schedule);
      query.addEventListener("keydown", function (event) {
        if (event.key === "Enter") { event.preventDefault(); } // Enter must not save
      });
      schedule();

      file.addEventListener("change", function () {
        var picked = file.files && file.files[0];
        if (!picked) { return; }
        say("");
        busy(true);
        decodeFile(picked).then(function (decoded) {
          var big, small;
          try {
            big = canvasOf(decoded.image, SAVE_SIDE);
            small = canvasOf(decoded.image, PENDING_SIDE).toDataURL("image/jpeg", PENDING_QUALITY);
          } finally { decoded.done(); }
          return jpegBlob(big, SAVE_QUALITY).then(function (blob) { return { blob: blob, small: small }; });
        }).then(function (made) {
          if (previewUrl) { URL.revokeObjectURL(previewUrl); }
          previewUrl = URL.createObjectURL(made.blob);
          setPreview(previewUrl);
          select({ kind: "own", blob: made.blob, small: made.small });
        }, function () {
          busy(false);
          say(t.photo_unreadable, true); // the panel and any earlier choice stay
        });
      });

      cancel.addEventListener("click", function () { say(""); done(); });

      function target(path) { return { repo: data.repo, branch: data.branch, path: path }; }

      // The image to commit: the uploaded photo as prepared, or the Commons file at 1200 px
      // (Commons serves it to anonymous cross-origin reads, so the canvas can be exported).
      function imageBlob(picked) {
        if (picked.kind === "own") { return Promise.resolve(picked.blob); }
        return loadImage(picked.result.url, true).then(function (img) {
          return jpegBlob(canvasOf(img, SAVE_SIDE), SAVE_QUALITY);
        }).then(null, function () { throw { result: { ok: false, error: "network" } }; });
      }

      form.addEventListener("submit", function (event) {
        event.preventDefault();
        if (!choice) { return; }
        var token = readStore(TOKEN_KEY);
        if (!token) { say(t.notes_error_token, true); return; }
        var picked = choice;
        var stamp = nowIso();
        var commit = "chore: update photo of " + item.title;
        var entry = picked.kind === "own" ? { source: "own", credit: null, page: null }
          : { source: "commons", credit: picked.result.credit, page: picked.result.page };
        busy(true);
        say(t.notes_saving);
        var blob = null;
        imageBlob(picked).then(function (made) {
          blob = made;
          return base64Of(made);
        }).then(function (content) {
          return notes.notesPutFile(fetchFn, target(data.images + "/" + item.offer + ".jpg"), token,
                                    content, commit);
        }).then(function (result) {
          if (!result.ok) { throw { result: result }; }
          return notes.notesPutJson(fetchFn, target(data.path), token, function (current) {
            return photosMergeEntry(current, item.offer, entry, stamp);
          }, commit);
        }).then(function (result) {
          if (!result.ok) { throw { result: result }; }
          storePending(item.offer, { savedAt: Date.now(), source: entry.source,
                                     credit: entry.credit, page: entry.page, updated: stamp,
                                     image: picked.kind === "own" ? picked.small : picked.result.thumb });
          done({ src: URL.createObjectURL(blob) });
        }).then(null, function (thrown) {
          busy(false); // the panel keeps its choice
          say(errorText(thrown && thrown.result ? thrown.result : { error: "other" }), true);
        });
      });

      if (remove) {
        remove.addEventListener("click", function () {
          var token = readStore(TOKEN_KEY);
          if (!token) { say(t.notes_error_token, true); return; }
          var stamp = nowIso();
          busy(true);
          say(t.notes_saving);
          notes.notesPutJson(fetchFn, target(data.path), token, function (current) {
            return photosMergeEntry(current, item.offer, null, stamp);
          }, "chore: remove photo of " + item.title).then(function (result) {
            if (!result.ok) { busy(false); say(errorText(result), true); return; }
            storePending(item.offer, { savedAt: Date.now(), removed: true });
            done({ removed: true });
          });
        });
      }

      return {
        form: form,
        focus: function () { query.focus(); },
        close: function () {
          searchRun++;
          clearTimeout(searchTimer);
          if (previewUrl) { URL.revokeObjectURL(previewUrl); }
          form.remove();
        }
      };
    }
    return buildPanel;
  }


  var node = document.getElementById("photos-data");
  if (!node) { return; }
  var data = JSON.parse(node.textContent);
  if (document.querySelector(".centrepieces")) { initShelf(data); }
  else if (data.consoles.length === 1 && document.querySelector(".exhibit")) { initItem(data, data.consoles[0]); }
})(typeof window !== "undefined" ? window : globalThis);
