(function (root) {
  "use strict";
  // The owner's notes: edit a game's copy note, score and play status from its page and save
  // them to data/notes.json in the private repository through GitHub's contents API, with the
  // token kept in this browser by the owner page. Pages built without a notes target carry
  // no #notes-data block, so nothing here runs for them.

  var FIELDS = ["note", "score", "status"];
  var STATUSES = ["done", "in_progress", "todo"];
  var TOKEN_KEY = "museum-github-token";
  var RAWG_KEY = "museum-rawg-key";
  var PENDING_KEY = "museum-notes-pending";
  var PENDING_MS = 3600000; // a saved value is shown over the built page for at most an hour
  var API = "https://api.github.com/repos/";
  var MAX_NOTE = 2000;

  function isEmpty(value) { return value === null || value === undefined || value === ""; }

  // The notes file with this offer's entry changed: only the keys present in `changes` are
  // set, an empty value removes its key, an entry left without any field is removed.
  function notesMergeEntry(file, offerId, changes, nowIso) {
    var out = file ? JSON.parse(JSON.stringify(file)) : { version: 1, items: {} };
    if (!out.items || typeof out.items !== "object") { out.items = {}; }
    var entry = Object.assign({}, out.items[offerId] || {});
    FIELDS.forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) { return; }
      var value = typeof changes[key] === "string" ? changes[key].trim() : changes[key];
      if (isEmpty(value)) { delete entry[key]; } else { entry[key] = value; }
    });
    if (FIELDS.some(function (key) { return !isEmpty(entry[key]); })) {
      entry.updated = nowIso;
      out.items[offerId] = entry;
    } else {
      delete out.items[offerId];
    }
    return out;
  }

  // File content for the contents API: UTF-8 JSON, 2-space indent, trailing newline, base64.
  function notesEncodeContent(file) {
    var bytes = new TextEncoder().encode(JSON.stringify(file, null, 2) + "\n");
    var bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  // GitHub sends the content as base64 wrapped in lines.
  function notesDecodeContent(b64) {
    var bin = atob(String(b64).replace(/\s+/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function same(a, b) { return (isEmpty(a) ? null : a) === (isEmpty(b) ? null : b); }

  // The values saved from this browser to show instead of the built ones, or null once the
  // built page carries them or an hour has passed.
  function notesPendingFor(pending, built, nowMs) {
    if (!pending || !pending.values || typeof pending.savedAt !== "number") { return null; }
    if (nowMs - pending.savedAt > PENDING_MS) { return null; }
    var values = pending.values;
    if (FIELDS.every(function (key) { return same(values[key], built[key]); })) { return null; }
    return values;
  }

  function apiHeaders(token) {
    return { Authorization: "Bearer " + token, Accept: "application/vnd.github+json",
             "X-GitHub-Api-Version": "2022-11-28" };
  }

  function failure(error, code) {
    var result = { ok: false, error: error };
    if (code !== undefined) { result.code = code; }
    return result;
  }

  function statusFailure(status) {
    if (status === 401 || status === 403) { return failure("token", status); }
    if (status === 409) { return failure("conflict", status); }
    return failure("other", status);
  }

  // fetch that turns a thrown request (no connection) into a "network" failure.
  function request(fetchFn, url, init) {
    return Promise.resolve().then(function () { return fetchFn(url, init); })
      .then(null, function () { throw { result: failure("network") }; });
  }

  function settle(promise) {
    return promise.then(null, function (thrown) {
      return thrown && thrown.result ? thrown.result : failure("other");
    });
  }

  function contentsUrl(target) { return API + target.repo + "/contents/" + target.path; }

  function readUrl(target) { return contentsUrl(target) + "?ref=" + encodeURIComponent(target.branch); }

  // {file, sha} of a JSON file of the repository ({file: null} when it is missing); throws
  // {result} on any other answer, never handing back something it could not read.
  function readJson(fetchFn, target, headers) {
    return request(fetchFn, readUrl(target), { headers: headers, cache: "no-store" })
      .then(function (response) {
        if (response.status === 404) { return { file: null }; }
        if (!response.ok) { throw { result: statusFailure(response.status) }; }
        return response.json().then(function (body) {
          return { file: notesDecodeContent(body.content), sha: body.sha };
        }).then(null, function () {
          throw { result: failure("other", response.status) }; // never overwrite what we cannot read
        });
      });
  }

  // {ok: true, file, sha} of a JSON file of the repository (file null when missing), or a failure.
  function notesReadJson(fetchFn, target, token) {
    return settle(readJson(fetchFn, target, apiHeaders(token)).then(function (current) {
      var result = { ok: true, file: current.file };
      if (current.sha) { result.sha = current.sha; }
      return result;
    }));
  }

  // Read a JSON file of the repository (a missing one reads as null), pass it through
  // `transform`, write the result back with the read sha; when the file changed in between
  // (409, or 422 when it was created after a 404 read), read and write once more.
  function notesPutJson(fetchFn, target, token, transform, message) {
    var headers = apiHeaders(token);

    function attempt(retried) {
      return readJson(fetchFn, target, headers)
        .then(function (current) {
          var body = { message: message, content: notesEncodeContent(transform(current.file)),
                       branch: target.branch };
          if (current.sha) { body.sha = current.sha; }
          return request(fetchFn, contentsUrl(target), {
            method: "PUT", headers: Object.assign({ "Content-Type": "application/json" }, headers),
            body: JSON.stringify(body)
          });
        })
        .then(function (response) {
          if (response.ok) { return { ok: true }; }
          // 409/422: the file changed or appeared since the read (a missing file read as 404).
          if ((response.status === 409 || response.status === 422) && !retried) { return attempt(true); }
          if (response.status === 404) { throw { result: failure("token", 404) }; } // repository not visible
          throw { result: statusFailure(response.status) };
        });
    }
    return settle(attempt(false));
  }

  // Create a file of the repository unless it exists: {ok: true, existed}. `makeContent` (only
  // called for a missing file) resolves to its base64 content, or null when there is nothing to
  // write ({ok: false, error: "empty"}); a rejection is an "other" failure. A 422 on the PUT
  // (the file appeared in the meantime) counts as existing only once a new read finds it.
  function notesPutNewFile(fetchFn, target, token, makeContent, message) {
    var headers = apiHeaders(token);
    return settle(request(fetchFn, readUrl(target), { headers: headers, cache: "no-store" })
      .then(function (response) {
        if (response.ok) { return { ok: true, existed: true }; }
        if (response.status !== 404) { throw { result: statusFailure(response.status) }; }
        return Promise.resolve().then(makeContent).then(null, function () {
          throw { result: failure("other") };
        }).then(function (content) {
          if (content === null || content === undefined) { return failure("empty"); }
          return request(fetchFn, contentsUrl(target), {
            method: "PUT", headers: Object.assign({ "Content-Type": "application/json" }, headers),
            body: JSON.stringify({ message: message, content: content, branch: target.branch })
          }).then(function (put) {
            if (put.ok) { return { ok: true, existed: false }; }
            if (put.status === 422) {
              return request(fetchFn, readUrl(target), { headers: headers, cache: "no-store" })
                .then(function (again) {
                  return again.ok ? { ok: true, existed: true } : failure("other", 422);
                });
            }
            if (put.status === 404) { throw { result: failure("token", 404) }; }
            throw { result: statusFailure(put.status) };
          });
        });
      }));
  }

  // Replace or create one file with already-encoded base64 content (an image): the current
  // file's sha is read first, since replacing a file needs it; one retry on 409/422.
  function notesPutFile(fetchFn, target, token, base64Content, message) {
    var headers = apiHeaders(token);

    function attempt(retried) {
      return request(fetchFn, readUrl(target), { headers: headers, cache: "no-store" })
        .then(function (response) {
          if (response.status === 404) { return null; }
          if (!response.ok) { throw { result: statusFailure(response.status) }; }
          return response.json().then(function (body) { return body.sha || null; })
            .then(null, function () { throw { result: failure("other", response.status) }; });
        })
        .then(function (sha) {
          var body = { message: message, content: base64Content, branch: target.branch };
          if (sha) { body.sha = sha; }
          return request(fetchFn, contentsUrl(target), {
            method: "PUT", headers: Object.assign({ "Content-Type": "application/json" }, headers),
            body: JSON.stringify(body)
          });
        })
        .then(function (response) {
          if (response.ok) { return { ok: true }; }
          if ((response.status === 409 || response.status === 422) && !retried) { return attempt(true); }
          if (response.status === 404) { throw { result: failure("token", 404) }; }
          throw { result: statusFailure(response.status) };
        });
    }
    return settle(attempt(false));
  }

  // Change this offer's entry of the notes file.
  function notesSave(fetchFn, target, offerId, changes, token, title, nowIso) {
    return notesPutJson(fetchFn, target, token, function (file) {
      return notesMergeEntry(file, offerId, changes, nowIso);
    }, "chore: update notes for " + title);
  }

  // {date: "YYYY-MM-DD", days, warn} from GitHub's token expiry header, or null.
  function tokenExpiry(header, nowMs) {
    var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/
      .exec(String(header || "").trim());
    if (!m) { return null; }
    var zone = !m[3] || m[3] === "UTC" || m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
    var at = Date.parse(m[1] + "T" + m[2] + zone);
    if (isNaN(at)) { return null; }
    var days = Math.floor((at - nowMs) / 86400000);
    return { date: m[1], days: days, warn: days <= 14 };
  }

  // Can this token write to the repository? Reads the repository and its expiry header.
  function notesCheckToken(fetchFn, repo, token, nowMs) {
    return settle(request(fetchFn, API + repo, { headers: apiHeaders(token), cache: "no-store" })
      .then(function (response) {
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          return failure("token", response.status);
        }
        if (!response.ok) { return failure("other", response.status); }
        return response.json().then(function (body) {
          if (!(body && body.permissions && body.permissions.push)) { return failure("read_only"); }
          var header = response.headers && response.headers.get
            ? response.headers.get("github-authentication-token-expiration") : null;
          return { ok: true, expiry: tokenExpiry(header, nowMs) };
        });
      }));
  }

  // Does RAWG accept this key? One search request (the key goes to api.rawg.io only):
  // {ok: true}, {ok: false, error: "key", code} for 401/403, "other" or "network" otherwise.
  function notesCheckRawgKey(fetchFn, key, timeoutMs) {
    var url = "https://api.rawg.io/api/games?search=mario&page_size=1&key=" + encodeURIComponent(String(key).trim());
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer;
    var timeout = new Promise(function (resolve, reject) { // an unanswered request is a network failure after 8 s
      timer = setTimeout(function () { if (controller) { controller.abort(); } reject(new Error("timeout")); }, timeoutMs || 8000);
    });
    var request = Promise.resolve().then(function () {
      return controller ? fetchFn(url, { signal: controller.signal }) : fetchFn(url);
    });
    return Promise.race([request, timeout]).then(function (response) {
      clearTimeout(timer);
      if (response.ok) { return { ok: true }; }
      if (response.status === 401 || response.status === 403) { return { ok: false, error: "key", code: response.status }; }
      return { ok: false, error: "other", code: response.status };
    }, function () { clearTimeout(timer); return { ok: false, error: "network" }; });
  }

  var api = {
    notesMergeEntry: notesMergeEntry,
    notesEncodeContent: notesEncodeContent,
    notesDecodeContent: notesDecodeContent,
    notesPendingFor: notesPendingFor,
    notesReadJson: notesReadJson,
    notesPutJson: notesPutJson,
    notesPutNewFile: notesPutNewFile,
    notesPutFile: notesPutFile,
    notesSave: notesSave,
    notesCheckToken: notesCheckToken,
    notesCheckRawgKey: notesCheckRawgKey
  };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.museumNotes = api; // lists.js, loaded after this file, takes its helpers from here
  if (typeof document === "undefined") { return; }

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
    } catch (e) { /* storage unavailable */ }
  }

  function format(text, values) {
    return text.replace(/\{(\w+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }

  function initItem(data) {
    var t = data.strings;
    var hardware = !!data.hardware;
    var fields = hardware ? ["note"] : FIELDS;
    var current = data.values;

    // Same format as item.html: "9 / 10", the status label, data-value, hidden when empty.
    function show(values) {
      fields.forEach(function (field) {
        var dt = document.querySelector('[data-notes-label="' + field + '"]');
        var dd = document.querySelector('[data-notes-field="' + field + '"]');
        if (!dt || !dd) { return; }
        var value = values[field];
        dt.hidden = dd.hidden = isEmpty(value);
        dd.removeAttribute("data-value");
        if (isEmpty(value)) { dd.textContent = ""; return; }
        if (field === "note") {
          dd.textContent = value;
        } else if (field === "score") {
          dd.textContent = value + " / 10";
          dd.setAttribute("data-value", String(value));
        } else {
          dd.textContent = t["status_" + value] || value;
          dd.setAttribute("data-value", value);
        }
      });
    }

    var now = Date.now();
    var pending = readPending();
    Object.keys(pending).forEach(function (offer) {
      var entry = pending[offer];
      if (!entry || typeof entry.savedAt !== "number" || now - entry.savedAt > PENDING_MS) {
        delete pending[offer];
      }
    });
    var overlay = notesPendingFor(pending[data.offer], data.values, now);
    if (overlay) {
      current = overlay;
      show(current);
    } else {
      delete pending[data.offer];
    }
    writePending(pending);

    var editor = document.querySelector(".notes-editor");
    if (!editor || !readStore(TOKEN_KEY)) { return; } // visitors without the token see no controls
    var button = el("button", "notes-edit", t.notes_edit);
    button.type = "button";
    var message = el("p", "notes-message");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    editor.appendChild(button);
    editor.appendChild(message);
    var form = null;

    function say(text, isError) {
      message.textContent = text;
      message.classList.toggle("notes-error", !!isError);
    }

    function close() {
      if (form) { form.remove(); form = null; }
      button.hidden = false;
      button.focus();
    }

    function buildForm(values) {
      var f = el("form", "notes-form");
      var noteLabel = el("label", "notes-label", t.copy_note);
      noteLabel.htmlFor = "notes-note";
      var note = el("textarea");
      note.id = "notes-note";
      note.maxLength = MAX_NOTE;
      note.rows = 4;
      note.value = values.note || "";
      f.appendChild(noteLabel);
      f.appendChild(note);
      var score = null;
      if (!hardware) {
        var scoreLabel = el("label", "notes-label", t.my_score);
        scoreLabel.htmlFor = "notes-score";
        score = el("select");
        score.id = "notes-score";
        score.appendChild(new Option("—", ""));
        for (var n = 0; n <= 10; n++) { score.appendChild(new Option(String(n), String(n))); }
        score.value = isEmpty(values.score) ? "" : String(values.score);
        f.appendChild(scoreLabel);
        f.appendChild(score);
        var group = el("fieldset", "notes-status");
        group.appendChild(el("legend", "notes-label", t.play_status));
        STATUSES.concat([""]).forEach(function (value) {
          var label = el("label");
          var radio = el("input");
          radio.type = "radio";
          radio.name = "notes-status";
          radio.value = value;
          radio.checked = (values.status || "") === value;
          label.appendChild(radio);
          label.appendChild(document.createTextNode(" " + t["status_" + (value || "none")]));
          group.appendChild(label);
        });
        f.appendChild(group);
      }
      var buttons = el("div", "notes-buttons");
      var save = el("button", "notes-save", t.notes_save);
      save.type = "submit";
      var cancel = el("button", "notes-cancel", t.notes_cancel);
      cancel.type = "button";
      buttons.appendChild(save);
      buttons.appendChild(cancel);
      f.appendChild(buttons);

      cancel.addEventListener("click", function () { say(""); close(); });
      f.addEventListener("submit", function (event) {
        event.preventDefault();
        var changes = { note: note.value.trim() || null };
        if (!hardware) {
          var checked = f.querySelector('input[name="notes-status"]:checked');
          changes.score = score.value === "" ? null : Number(score.value);
          changes.status = checked && checked.value ? checked.value : null;
        }
        var token = readStore(TOKEN_KEY);
        if (!token) { say(t.notes_error_token, true); return; }
        save.disabled = cancel.disabled = true;
        say(t.notes_saving);
        notesSave(root.fetch.bind(root), data, data.offer, changes, token, data.title, nowIso())
          .then(function (result) {
            save.disabled = cancel.disabled = false;
            if (!result.ok) { // the form keeps what was typed
              say(result.error === "other"
                ? format(t.notes_error_other, { code: result.code === undefined ? "?" : result.code })
                : t["notes_error_" + result.error], true);
              return;
            }
            current = { note: changes.note, score: hardware ? null : changes.score,
                        status: hardware ? null : changes.status };
            show(current);
            var all = readPending();
            all[data.offer] = { values: current, savedAt: Date.now() };
            writePending(all);
            close();
            say(t.notes_saved);
          });
      });
      return f;
    }

    button.addEventListener("click", function () {
      say("");
      form = buildForm(current);
      button.hidden = true;
      editor.insertBefore(form, message);
      form.querySelector("textarea").focus();
    });
  }

  function initOwner(data) {
    var t = data.strings;
    var input = document.getElementById("owner-token");
    var test = document.getElementById("owner-test");
    var forget = document.getElementById("owner-forget");
    var status = document.getElementById("owner-status");
    if (!input || !test || !forget || !status) { return; }

    function say(text, kind) {
      status.textContent = text;
      status.className = kind ? "owner-" + kind : "";
    }

    function longDate(iso) {
      try {
        return new Date(iso + "T00:00:00Z").toLocaleDateString(document.documentElement.lang,
          { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
      } catch (e) { return iso; }
    }

    say(readStore(TOKEN_KEY) ? t.owner_has_token : t.owner_no_token);
    input.form.addEventListener("submit", function (event) {
      event.preventDefault();
      var token = input.value.trim() || readStore(TOKEN_KEY);
      if (!token) { say(t.owner_paste_first, "error"); input.focus(); return; }
      test.disabled = true;
      say(t.owner_testing);
      notesCheckToken(root.fetch.bind(root), data.repo, token, Date.now()).then(function (result) {
        test.disabled = false;
        if (result.ok) {
          try { root.localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* storage unavailable */ }
          input.value = "";
          var text = format(t.owner_ok, { repo: data.repo });
          if (result.expiry) {
            var key = (result.expiry.warn ? "owner_expires_soon" : "owner_expires")
              + (result.expiry.days === 1 ? "_one" : "");
            text += " " + format(t[key],
                                 { date: longDate(result.expiry.date), days: result.expiry.days });
          }
          say(text, result.expiry && result.expiry.warn ? "warn" : "ok");
        } else if (result.error === "read_only") {
          say(format(t.owner_read_only, { repo: data.repo }), "error");
        } else if (result.error === "token") {
          say(format(t.owner_refused, { code: result.code }), "error");
        } else if (result.error === "network") {
          say(t.owner_network, "error");
        } else {
          say(format(t.owner_other, { code: result.code === undefined ? "?" : result.code }), "error");
        }
      });
    });
    forget.addEventListener("click", function () {
      try { root.localStorage.removeItem(TOKEN_KEY); } catch (e) { /* storage unavailable */ }
      input.value = "";
      say(t.owner_forgotten);
    });
    initRawgKey(t);
  }

  // The RAWG key field of the owner page: kept in this browser only, after a successful test;
  // it is sent to api.rawg.io and nowhere else.
  function initRawgKey(t) {
    var input = document.getElementById("owner-rawg-key");
    var test = document.getElementById("owner-rawg-test");
    var remove = document.getElementById("owner-rawg-remove");
    var status = document.getElementById("owner-rawg-status");
    if (!input || !test || !remove || !status) { return; }

    function say(text, kind) {
      status.textContent = text;
      status.className = kind ? "owner-" + kind : "";
    }

    function showStored() {
      var stored = !!readStore(RAWG_KEY);
      input.placeholder = stored ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : "";
      return stored;
    }

    if (showStored()) { say(t.owner_has_rawg_key); }
    input.form.addEventListener("submit", function (event) {
      event.preventDefault();
      var key = input.value.trim() || readStore(RAWG_KEY);
      if (!key) { input.focus(); return; }
      test.disabled = true;
      say(t.owner_testing);
      notesCheckRawgKey(root.fetch.bind(root), key).then(function (result) {
        test.disabled = false;
        if (result.ok) {
          try { root.localStorage.setItem(RAWG_KEY, key); } catch (e) { /* storage unavailable */ }
          input.value = "";
          showStored();
          say(t.owner_rawg_ok, "ok");
        } else if (result.error === "key") { // refused: the stored key goes only if it is the one tested
          if (key === readStore(RAWG_KEY)) {
            try { root.localStorage.removeItem(RAWG_KEY); } catch (e) { /* storage unavailable */ }
          }
          showStored();
          say(t.owner_rawg_bad, "error");
        } else {
          say(t.owner_rawg_unreachable, "error");
        }
      });
    });
    remove.addEventListener("click", function () {
      try { root.localStorage.removeItem(RAWG_KEY); } catch (e) { /* storage unavailable */ }
      input.value = "";
      showStored();
      say(t.owner_rawg_removed);
    });
  }

  var notesNode = document.getElementById("notes-data");
  if (notesNode) { initItem(JSON.parse(notesNode.textContent)); }
  var ownerNode = document.getElementById("owner-data");
  if (ownerNode) { initOwner(JSON.parse(ownerNode.textContent)); }
})(typeof window !== "undefined" ? window : globalThis);
