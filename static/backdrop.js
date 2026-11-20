(function (root) {
  "use strict";
  // The owner's backdrop choice for a console: pick the Galerie band image among the
  // ScreenScraper fanart, background and "steamgrid" images and save it to data/backdrop-choices.json. This file
  // holds the pure logic; the page part comes after it.

  var SAVE_WIDTH = 1600;      // an uploaded image is committed at most this wide (JPEG)
  var SAVE_QUALITY = 0.85;
  var PENDING_WIDTH = 640;    // the small copy kept in this browser until the site is rebuilt
  var PENDING_QUALITY = 0.7;
  var PENDING_MS = 3600000; // a saved choice is shown over the built page for at most an hour

  // A saved or pending entry without a kind is a steamgrid image.
  function kindOf(entry) { return (entry && entry.kind) || "steamgrid"; }

  // The choices file with this console's entry set to `game` of `kind` (stamped with `updated`)
  // or removed (`game` null). Other consoles are untouched.
  function backdropMerge(file, consoleId, game, kind, updated) {
    var out = file ? JSON.parse(JSON.stringify(file)) : { choices: {} };
    out.version = 1;
    if (!out.choices || typeof out.choices !== "object") { out.choices = {}; }
    if (kind === "own") { out.choices[consoleId] = { kind: "own", updated: updated }; }
    else if (game) { out.choices[consoleId] = { game: game, kind: kind || "steamgrid", updated: updated }; }
    else { delete out.choices[consoleId]; }
    return out;
  }

  // What this browser saved for `consoleId` in the last hour: {game, kind, updated} for a choice,
  // {removed: true} for a reset to Automatic, null when there is nothing to show or the built
  // page already matches. `pending` maps console ids to {savedAt, removed} or
  // {savedAt, game, kind, updated}; `built` is the built page's {game, kind, updated}, or null.
  function backdropPendingFor(pending, consoleId, built, nowMs) {
    var entry = pending && pending[consoleId];
    if (!entry || typeof entry.savedAt !== "number") { return null; }
    if (nowMs - entry.savedAt > PENDING_MS) { return null; }
    if (entry.removed) { return built ? { removed: true } : null; }
    if (built && entry.updated && built.updated === entry.updated) { return null; }
    var overlay = { game: entry.game === undefined ? null : entry.game, kind: kindOf(entry), updated: entry.updated };
    if (entry.image) { overlay.image = entry.image; } // an own image's small copy
    return overlay;
  }

  // Whether Save has anything to do: the picked option differs from the choice in force.
  function backdropCanSave(picked, current) {
    if (picked && picked.upload) { return !picked.upload.saved; } // a new file always differs
    if (!picked || !current) { return !!picked !== !!current; }
    return picked.game !== current.game || kindOf(picked) !== kindOf(current);
  }

  // Output size of an uploaded image: width capped at 1600, never enlarged, ratio kept.
  function backdropSaveSize(width, height, max) {
    var cap = max || SAVE_WIDTH;
    if (width <= cap) { return { width: width, height: height }; }
    return { width: cap, height: Math.max(1, Math.round(height * cap / width)) };
  }

  // Commit the image (the sha of an existing file is read first), then the choices index, in
  // that order; the index is untouched when the image fails.
  function backdropSaveOwn(notes, fetchFn, repoBranch, imagesDir, indexPath, token, base64, consoleId, stamp) {
    var imageTarget = { repo: repoBranch.repo, branch: repoBranch.branch,
                        path: imagesDir + "/" + consoleId + ".jpg" };
    var indexTarget = { repo: repoBranch.repo, branch: repoBranch.branch, path: indexPath };
    return notes.notesPutFile(fetchFn, imageTarget, token, base64, "Backdrop image: " + consoleId)
      .then(function (result) {
        if (!result.ok) { return result; }
        return notes.notesPutJson(fetchFn, indexTarget, token, function (file) {
          return backdropMerge(file, consoleId, null, "own", stamp);
        }, "Backdrop: " + consoleId);
      });
  }

  var api = { backdropMerge: backdropMerge, backdropPendingFor: backdropPendingFor,
              backdropCanSave: backdropCanSave, backdropSaveSize: backdropSaveSize,
              backdropSaveOwn: backdropSaveOwn };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.museumBackdrop = api;
  if (typeof document === "undefined") { return; }

  // --- The page: a console's own page (Galerie theme) ---
  // Pages built without a notes target carry no #backdrop-data block, so nothing here runs
  // for them. The change button only appears in a browser holding the owner's token.

  var TOKEN_KEY = "museum-github-token";
  var PENDING_KEY = "museum-backdrop-pending";
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
    } catch (e) { /* storage unavailable: the page shows the choice until reloaded */ }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }

  function optionOf(data, pick) {
    if (!pick) { return null; }
    return data.options.filter(function (o) {
      return o.game === pick.game && kindOf(o) === kindOf(pick);
    })[0] || null;
  }

  // The backdrop figure showing `option`'s thumbnail (stretched, until the rebuild); created
  // when the console had none. The media loader decrypts and loads the new image.
  // What the page was built with: its backdrop figure and that figure's children, or none.
  var built = { figure: null, nodes: null, created: null };

  function rememberBuiltBackdrop() {
    var page = document.querySelector(".shelf-page");
    var figure = page && page.querySelector(".shelf-backdrop");
    if (figure) { built.figure = figure; built.nodes = Array.prototype.slice.call(figure.childNodes); }
  }

  // Put back the image the page was built with (or remove the figure created for a pick).
  function restoreBuiltBackdrop() {
    if (built.figure) { built.figure.replaceChildren.apply(built.figure, built.nodes); }
    else if (built.created) { built.created.remove(); built.created = null; }
  }

  function showBackdrop(option) {
    var page = document.querySelector(".shelf-page");
    if (!page || !option) { return; }
    var figure = built.figure || built.created;
    if (!figure) {
      figure = el("figure", "shelf-backdrop");
      page.insertBefore(figure, page.children[1] || null);
      built.created = figure;
    }
    var img = el("img");
    img.alt = "";
    if (option.small) { img.src = option.small; } // the owner's just-uploaded image: local, not encrypted
    else { img.setAttribute("data-media", option.thumb); }
    figure.replaceChildren(img);
    if (!option.small && root.museumLoadMedia) { root.museumLoadMedia(figure); }
  }

  // --- Reading an uploaded file ---

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("load")); };
      img.src = src;
    });
  }

  // {image, done} for an uploaded file; rejects when the browser cannot read it.
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

  // The image on a white canvas (JPEG has no transparency), `width` wide at most, never enlarged.
  function canvasOf(image, width) {
    var w = image.naturalWidth || image.width, h = image.naturalHeight || image.height;
    if (!w || !h) { throw new Error("size"); }
    var size = backdropSaveSize(w, h, width);
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

  function init(data) {
    var t = data.strings;
    var button = document.querySelector(".backdrop-change");
    var fetchFn = root.fetch ? root.fetch.bind(root) : null;
    rememberBuiltBackdrop();
    var now = Date.now();
    var pending = readPending();
    Object.keys(pending).forEach(function (id) {
      var entry = pending[id];
      if (!entry || typeof entry.savedAt !== "number" || now - entry.savedAt > PENDING_MS) {
        delete pending[id];
      }
    });
    var overlay = backdropPendingFor(pending, data.console, data.built, now);
    if (!overlay) { delete pending[data.console]; }
    writePending(pending);
    // the choice in force on this page: {game, kind}, or null for Automatic
    var current = data.built ? { game: data.built.game, kind: kindOf(data.built) } : null;
    if (overlay && overlay.removed) { current = null; }
    else if (overlay) {
      current = { game: overlay.game, kind: overlay.kind };
      showBackdrop(overlay.image ? { small: overlay.image } : optionOf(data, current));
    }

    if (!button || !notes || !fetchFn || !readStore(TOKEN_KEY)) { return; } // visitors see no controls
    button.hidden = false;

    var panel = null;

    function build() {
      var form = el("form", "backdrop-panel");
      var list = el("ul", "backdrop-options");
      var message = el("p", "notes-message backdrop-message");
      message.setAttribute("role", "status");
      message.setAttribute("aria-live", "polite");
      var picked = current;

      function say(text, isError) {
        message.textContent = text;
        message.classList.toggle("notes-error", !!isError);
      }

      var save = el("button", "notes-save", t.notes_save);
      save.type = "submit";
      save.disabled = true;
      var cancel = el("button", "notes-cancel", t.notes_cancel);
      cancel.type = "button";

      function mark() {
        Array.prototype.forEach.call(list.querySelectorAll("button"), function (b) {
          var same = b.backdropPick ? (picked && picked.game === b.backdropPick.game &&
                                       kindOf(picked) === kindOf(b.backdropPick) &&
                                       picked.upload === b.backdropPick.upload) : !picked;
          b.setAttribute("aria-pressed", String(!!same));
        });
      }

      function addOption(pickValue, title, caption, thumb, local) {
        var li = el("li");
        var pick = el("button", "backdrop-option");
        pick.type = "button";
        pick.backdropPick = pickValue;
        if (thumb) {
          var img = el("img");
          img.alt = "";
          if (local) { img.src = thumb; } else { img.setAttribute("data-media", thumb); }
          pick.appendChild(img);
        } else {
          pick.classList.add("backdrop-auto");
        }
        pick.appendChild(el("span", "backdrop-title", title));
        if (caption) { pick.appendChild(el("span", "backdrop-width muted", caption)); }
        pick.addEventListener("click", function () {
          picked = pickValue;
          mark();
          save.disabled = !backdropCanSave(picked, current);
          say("");
        });
        li.appendChild(pick);
        if (local) { list.insertBefore(li, list.firstChild); } else { list.appendChild(li); }
        return li;
      }

      addOption(null, t.backdrop_auto, null, null);
      data.options.forEach(function (o) {
        var label = t["backdrop_kind_" + kindOf(o)] || kindOf(o);
        addOption({ game: o.game, kind: kindOf(o) }, o.title,
                  o.width ? label + " \u00b7 " + o.width + " px" : label, o.thumb);
      });
      mark();
      var upload = el("div", "backdrop-upload");
      var file = el("input");
      file.type = "file";
      file.accept = "image/*";
      file.hidden = true;
      var uploadButton = el("button", "backdrop-upload-button", t.backdrop_upload);
      uploadButton.type = "button";
      uploadButton.addEventListener("click", function () { file.click(); });
      upload.appendChild(uploadButton);
      upload.appendChild(file);
      form.appendChild(upload);
      var uploadItem = null, previewUrl = null, working = false, decoding = 0;
      var ownCaption = t.backdrop_kind_own;
      file.addEventListener("change", function () {
        var chosen = file.files && file.files[0];
        file.value = ""; // the same file can be picked again
        if (!chosen || working) { return; }
        say("");
        decoding += 1;
        save.disabled = true;
        decodeFile(chosen).then(function (decoded) {
          var big, small, shownWidth;
          try {
            big = canvasOf(decoded.image, SAVE_WIDTH);
            shownWidth = big.width;
            small = canvasOf(decoded.image, PENDING_WIDTH).toDataURL("image/jpeg", PENDING_QUALITY);
          } finally { decoded.done(); }
          return jpegBlob(big, SAVE_QUALITY).then(function (blob) { return { blob: blob, small: small, width: shownWidth }; });
        }).then(function (made) {
          decoding -= 1;
          if (working) { return; } // a save started meanwhile: drop this late preview
          if (previewUrl) { URL.revokeObjectURL(previewUrl); }
          if (uploadItem) { uploadItem.remove(); }
          previewUrl = URL.createObjectURL(made.blob);
          var pickValue = { game: null, kind: "own", upload: { blob: made.blob, small: made.small } };
          uploadItem = addOption(pickValue, t.backdrop_kind_own,
                                 made.width ? ownCaption + " \u00b7 " + made.width + " px" : ownCaption,
                                 previewUrl, true);
          picked = pickValue;
          mark();
          save.disabled = !backdropCanSave(picked, current);
        }, function () {
          decoding -= 1;
          if (!working) { save.disabled = !backdropCanSave(picked, current); }
          say(t.photo_unreadable, true); // the panel and any earlier choice stay
        });
      });
      form.appendChild(list);
      var buttons = el("div", "notes-buttons");
      buttons.appendChild(save);
      buttons.appendChild(cancel);
      form.appendChild(buttons);
      form.appendChild(message);

      function busy(on) {
        working = on;
        uploadButton.disabled = on;
        file.disabled = on;
        save.disabled = on || decoding > 0;
        cancel.disabled = on;
        Array.prototype.forEach.call(list.querySelectorAll("button"), function (b) { b.disabled = on; });
      }

      function errorText(result) {
        if (result.error === "other" || !t["notes_error_" + result.error]) {
          return t.notes_error_other.replace("{code}", result.code === undefined ? "?" : result.code);
        }
        return t["notes_error_" + result.error];
      }

      cancel.addEventListener("click", function () {
        picked = current;
        mark();
        save.disabled = true;
        say("");
        form.hidden = true;
        button.setAttribute("aria-expanded", "false");
        button.focus();
      });

      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var token = readStore(TOKEN_KEY);
        if (!token) { say(t.notes_error_token, true); return; }
        var game = picked ? picked.game : null;
        var kind = picked ? kindOf(picked) : null;
        var stamp = nowIso();
        var target = { repo: data.repo, branch: data.branch, path: data.path };
        var pickedNow = picked;
        var newFile = pickedNow && pickedNow.upload;
        busy(true);
        say(t.notes_saving);
        var saving;
        if (newFile) {
          saving = base64Of(newFile.blob).then(function (content) {
            return backdropSaveOwn(notes, fetchFn, { repo: data.repo, branch: data.branch },
                                   data.images, data.path, token, content, data.console, stamp);
          }, function () { return { ok: false, error: "other" }; });
        } else {
          saving = notes.notesPutJson(fetchFn, target, token, function (file) {
            return backdropMerge(file, data.console, game, kind, stamp);
          }, "Backdrop: " + data.console);
        }
        saving.then(function (result) {
          if (!result.ok) { busy(false); save.disabled = decoding > 0 || !backdropCanSave(picked, current); say(errorText(result), true); return; }
          var all = readPending();
          var shown = !!pickedNow;
          if (newFile) { all[data.console] = { savedAt: Date.now(), kind: "own", updated: stamp, image: newFile.small }; }
          else if (kind === "own") { all[data.console] = { savedAt: Date.now(), kind: "own", updated: stamp }; }
          else if (game) { all[data.console] = { savedAt: Date.now(), game: game, kind: kind, updated: stamp }; }
          else { all[data.console] = { savedAt: Date.now(), removed: true }; }
          writePending(all);
          current = pickedNow ? { game: game, kind: kind } : null;
          if (newFile) { newFile.saved = true; showBackdrop({ small: newFile.small }); }
          else if (shown) { showBackdrop(optionOf(data, pickedNow)); }
          else { restoreBuiltBackdrop(); }
          busy(false);
          save.disabled = true;
          say(t.notes_saved);
        });
      });

      return form;
    }

    button.addEventListener("click", function () {
      if (!panel) {
        panel = build();
        button.parentNode.insertBefore(panel, button.nextSibling); // right after the band
        if (root.museumLoadMedia) { root.museumLoadMedia(panel); }
      } else {
        panel.hidden = !panel.hidden;
        if (!panel.hidden && root.museumLoadMedia) { root.museumLoadMedia(panel); }
      }
      button.setAttribute("aria-expanded", String(!panel.hidden));
    });
  }

  var node = document.getElementById("backdrop-data");
  if (node) { init(JSON.parse(node.textContent)); }
})(typeof window !== "undefined" ? window : globalThis);
