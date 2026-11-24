(function (root) {
  "use strict";
  // The owner's tier lists: the pure editing logic (this part runs under node in the tests).
  // The lists live in data/lists.json of the private repository; every function returns new
  // objects and enforces the limits museum/lists.py checks at build time.

  var DEFAULT_TIERS = ["S", "A", "B", "C", "D"];
  var MAX_LISTS = 50;
  var MAX_ITEMS = 200;
  var MAX_TITLE = 80;
  var MAX_LABEL = 30;
  var MAX_TIERS = 10;
  var PENDING_MS = 3600000; // a saved list is shown over the built page for at most an hour
  var COVER_SIDE = 600;      // longest side of a committed cover, in pixels

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function limit() { return new Error("limit"); }

  function checkedText(text, max) {
    var value = String(text === null || text === undefined ? "" : text).trim();
    if (!value || value.length > max) { throw limit(); }
    return value;
  }

  function listsNew(id, title) {
    return {
      id: id,
      title: checkedText(title, MAX_TITLE),
      tiers: DEFAULT_TIERS.map(function (label) { return { label: label, items: [] }; }),
      unplaced: []
    };
  }

  // The file with this list replaced (or appended), or removed when `list` is null.
  function listsMerge(file, list, listId, nowIso) {
    var out = file ? clone(file) : { version: 1, lists: [] };
    if (!Array.isArray(out.lists)) { out.lists = []; }
    var at = -1;
    out.lists.forEach(function (entry, index) { if (entry.id === listId) { at = index; } });
    if (list === null || list === undefined) {
      if (at >= 0) { out.lists.splice(at, 1); }
      return out;
    }
    var copy = clone(list);
    copy.updated = nowIso;
    if (at >= 0) { out.lists[at] = copy; }
    else {
      if (out.lists.length >= MAX_LISTS) { throw limit(); }
      out.lists.push(copy);
    }
    return out;
  }

  function listsItemKey(item) {
    if (item.offer !== undefined) { return "offer:" + item.offer; }
    return item.rawg !== undefined ? "rawg:" + item.rawg : "wikidata:" + item.wikidata;
  }

  // The id of a game's cover file (data/list-covers/<id>.jpg): the Wikidata id, or rawg-<id>;
  // null for a collection game.
  function coverId(item) {
    if (item.wikidata) { return item.wikidata; }
    return item.rawg !== undefined ? "rawg-" + item.rawg : null;
  }

  function allItems(list) {
    var items = (list.unplaced || []).slice();
    list.tiers.forEach(function (tier) { items = items.concat(tier.items); });
    return items;
  }

  // The item added to "À classer"; refused (added: false) when the list already has it or is full.
  function listsAdd(list, item) {
    var items = allItems(list);
    var key = listsItemKey(item);
    var duplicate = items.some(function (other) { return listsItemKey(other) === key; });
    if (duplicate || items.length >= MAX_ITEMS) { return { list: list, added: false }; }
    var out = clone(list);
    out.unplaced = (out.unplaced || []).concat([clone(item)]);
    return { list: out, added: true };
  }

  function takeOut(list, key) {
    var found = null;
    function strip(items) {
      return items.filter(function (item) {
        if (found === null && listsItemKey(item) === key) { found = item; return false; }
        return true;
      });
    }
    list.unplaced = strip(list.unplaced || []);
    list.tiers.forEach(function (tier) { tier.items = strip(tier.items); });
    return found;
  }

  // Move a game to a tier (index) or to "unplaced", at a position; the list unchanged when the
  // game or the target is unknown.
  function listsMove(list, key, toTier, toIndex) {
    var out = clone(list);
    var target;
    if (toTier === "unplaced") { target = "unplaced"; }
    else if (typeof toTier === "number" && out.tiers[toTier]) { target = toTier; }
    else { return list; }
    var item = takeOut(out, key);
    if (item === null) { return list; }
    var items = target === "unplaced" ? out.unplaced : out.tiers[target].items;
    var at = Math.max(0, Math.min(Number(toIndex) || 0, items.length));
    items.splice(at, 0, item);
    return out;
  }

  function listsRemoveItem(list, key) {
    var out = clone(list);
    return takeOut(out, key) === null ? list : out;
  }

  function listsAddTier(list, label) {
    var text = checkedText(label, MAX_LABEL);
    if (list.tiers.length >= MAX_TIERS) { throw limit(); }
    var out = clone(list);
    out.tiers.push({ label: text, items: [] });
    return out;
  }

  // Remove a tier, its games going to "À classer"; the last tier cannot be removed.
  function listsRemoveTier(list, index) {
    if (list.tiers.length <= 1 || !list.tiers[index]) { return list; }
    var out = clone(list);
    var removed = out.tiers.splice(index, 1)[0];
    out.unplaced = (out.unplaced || []).concat(removed.items);
    return out;
  }

  function listsRename(list, title) {
    var out = clone(list);
    out.title = checkedText(title, MAX_TITLE);
    return out;
  }

  function listsRelabel(list, index, label) {
    var text = checkedText(label, MAX_LABEL);
    if (!list.tiers[index]) { return list; }
    var out = clone(list);
    out.tiers[index].label = text;
    return out;
  }

  // "YYYY" for a year (or month) precision, "YYYY-MM-DD" for a day, from "+1995-03-11T00:00:00Z".
  function wikidataDate(value) {
    var m = /^\+?(\d{1,4})-(\d{2})-(\d{2})T/.exec(String((value && value.time) || ""));
    if (!m) { return null; }
    var year = ("0000" + m[1]).slice(-4);
    if (value.precision >= 11 && m[2] !== "00" && m[3] !== "00") {
      return year + "-" + m[2] + "-" + m[3];
    }
    return year;
  }

  function claimValue(claim) {
    var snak = claim && claim.mainsnak;
    return snak && snak.datavalue ? snak.datavalue.value : null;
  }

  function qualifierIds(claim) {
    var list = (claim.qualifiers && claim.qualifiers.P400) || [];
    return list.map(function (q) { return q.datavalue && q.datavalue.value && q.datavalue.value.id; });
  }

  function labelText(source, lang) {
    var entry = source && source[lang];
    var text = typeof entry === "string" ? entry : entry && entry.value;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  }

  // French and English names, each falling back to Wikidata's multilingual label ("mul"),
  // which now holds the names that are the same in every language (Nintendo Switch, most
  // game titles) instead of separate fr/en labels.
  function labelsOf(source) {
    var out = {};
    var shared = labelText(source, "mul");
    ["fr", "en"].forEach(function (lang) {
      var text = labelText(source, lang) || shared;
      if (text) { out[lang] = text; }
    });
    return out;
  }

  // The list item for a Wikidata video game and the platforms to choose from. `lang` is the
  // page language (it picks the platform names shown); both labels that exist are kept in the
  // item. Throws Error("title") / Error("platform") when the entity has no label or platform.
  function listsWikidataItem(entity, lang, platformQid) {
    var claims = entity.claims || {};
    var labels = entity.platformLabels || {};
    var platforms = [];
    (claims.P400 || []).forEach(function (claim) {
      var value = claimValue(claim);
      if (!value || !value.id || platforms.some(function (p) { return p.qid === value.id; })) { return; }
      var names = labelsOf(labels[value.id]);
      platforms.push({ qid: value.id, label: names[lang] || names.fr || names.en || value.id });
    });
    var chosen = platformQid || (platforms.length ? platforms[0].qid : null);
    var title = labelsOf(entity.labels);
    if (!Object.keys(title).length) { throw new Error("title"); }
    if (!chosen) { throw new Error("platform"); }
    var platform = labelsOf(labels[chosen]);
    if (!Object.keys(platform).length) { platform = { fr: chosen, en: chosen }; }
    var dates = [];
    (claims.P577 || []).forEach(function (claim) {
      var value = claimValue(claim);
      var date = value ? wikidataDate(value) : null;
      if (date) { dates.push({ date: date, time: value.time, own: qualifierIds(claim).indexOf(chosen) >= 0 }); }
    });
    // The chosen console's own date. Without one, the earliest date only when no date is tied
    // to a console or the game came out on one console: otherwise it would be another
    // console's date (e.g. a re-release filed under the original game), so no date at all.
    var pool = dates.filter(function (d) { return d.own; });
    var tiedToConsoles = (claims.P577 || []).some(function (claim) { return qualifierIds(claim).length; });
    if (!pool.length && (!tiedToConsoles || platforms.length <= 1)) { pool = dates; }
    pool.sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
    return {
      item: { wikidata: entity.id, title: title, platform: platform,
              date: pool.length ? pool[0].date : null, cover: null },
      platforms: platforms
    };
  }

  // The built lists with this browser's recent saves applied: `pending` maps a list id to
  // {savedAt, list} (saved) or {savedAt, deleted: true}; entries older than an hour are ignored.
  function listsPendingView(pending, built, nowMs) {
    var live = {};
    Object.keys(pending || {}).forEach(function (id) {
      var entry = pending[id];
      if (entry && typeof entry.savedAt === "number" && nowMs - entry.savedAt <= PENDING_MS) { live[id] = entry; }
    });
    var seen = {};
    var out = [];
    built.forEach(function (list) {
      seen[list.id] = true;
      var entry = live[list.id];
      if (!entry) { out.push(list); }
      else if (!entry.deleted && entry.list) { out.push(entry.list); }
    });
    Object.keys(live).forEach(function (id) {
      if (!seen[id] && !live[id].deleted && live[id].list) { out.push(live[id].list); }
    });
    return out;
  }

  // The notes helpers: notes.js is loaded first in the browser and exposes window.museumNotes.
  var notes = typeof module !== "undefined" && module.exports ? require("./notes.js") : root.museumNotes;

  // A new list id: 8 lowercase hex characters, not one of `taken`. `randomBytes(n)` is
  // crypto.getRandomValues on n bytes in the browser.
  function listsNewId(randomBytes, taken) {
    for (;;) {
      var id = Array.prototype.map.call(randomBytes(4), function (b) {
        return ("0" + b.toString(16)).slice(-2);
      }).join("");
      if ((taken || []).indexOf(id) < 0) { return id; }
    }
  }

  // Same folding as the search of app.js and museum/site/search.py.
  function fold(text) {
    return String(text || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  }

  // Search index entries whose title holds every word of the query.
  function listsFindInCollection(index, query, limit) {
    var words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) { return []; }
    return index.filter(function (entry) {
      var title = fold(entry.title);
      return words.every(function (word) { return title.indexOf(word) >= 0; });
    }).slice(0, limit);
  }

  // Upload the cover of each Wikipedia game still without one, one after the other (GitHub
  // refuses two commits racing on a branch): a cover already in the repository is not sent
  // again; `makeCover(qid)` resolves to the base64 JPEG, or null when the article has no image.
  // Resolves to {list: the list with the stored covers set, stored: {qid: path}, failed: [qid]}
  // (left null, retried on the next save).
  function listsSaveCovers(fetchFn, target, token, list, makeCover) {
    var out = clone(list);
    var failed = [];
    var stored = {};
    var items = [];
    out.tiers.forEach(function (tier) { items = items.concat(tier.items); });
    var todo = items.concat(out.unplaced || []).filter(function (item) { return coverId(item) && !item.cover; });
    return todo.reduce(function (previous, item) {
      return previous.then(function () {
        var id = coverId(item);
        var path = target.covers + "/" + id + ".jpg";
        return notes.notesPutNewFile(fetchFn, { repo: target.repo, branch: target.branch, path: path },
                                     token, function () { return makeCover(id); },
                                     "chore: add list cover " + id)
          .then(function (result) {
            if (result.ok) { item.cover = stored[id] = path; }
            else if (result.error !== "empty") { failed.push(id); }
          });
      });
    }, Promise.resolve()).then(function () { return { list: out, stored: stored, failed: failed }; });
  }

  // The list with the covers just stored ({cover id: path}) set on its Wikipedia and RAWG games still without
  // one, and nothing else changed: the editor stays usable while covers upload, so the list may
  // have changed since the save began.
  function listsSetCovers(list, stored) {
    var out = clone(list);
    out.tiers.forEach(function (tier) { setCovers(tier.items, stored); });
    setCovers(out.unplaced || [], stored);
    return out;
  }

  function setCovers(items, stored) {
    items.forEach(function (item) {
      var id = coverId(item);
      if (id && !item.cover && Object.prototype.hasOwnProperty.call(stored, id)) { item.cover = stored[id]; }
    });
  }

  // The lists file transform of a save: this list replaced or added. `flags.limit` is set when
  // it would be a 51st list (another device may have added one since the editor opened).
  function listsSaveTransform(list, nowIso, flags) {
    return function (file) {
      try { return listsMerge(file, list, list.id, nowIso); }
      catch (e) {
        if (e && e.message === "limit") { flags.limit = true; }
        throw e;
      }
    };
  }

  // Thumbnail widths Wikimedia serves (it refuses other sizes and any upscaling).
  var THUMB_WIDTHS = [250, 330, 500, 960, 1280];

  // URL of the article's lead image to shrink into a cover, from a REST page summary: a
  // Wikimedia thumbnail just large enough for COVER_SIDE (always one for an SVG, which a canvas
  // cannot size), else the original; null without an image.
  function listsCoverUrl(summary) {
    var original = summary && summary.originalimage;
    var thumb = summary && summary.thumbnail;
    if (!original || !original.source) { return thumb && thumb.source ? thumb.source : null; }
    var w = Number(original.width), h = Number(original.height);
    var pattern = /\/\d+px-([^/]+)$/;
    if (!w || !h || !thumb || !thumb.source || !pattern.test(thumb.source)) { return original.source; }
    var svg = /\.svg$/i.test(original.source);
    var wanted = Math.round(COVER_SIDE * w / Math.max(w, h));
    if (!svg && wanted >= w) { return original.source; }
    var width = THUMB_WIDTHS.filter(function (n) { return n >= wanted; })[0] || THUMB_WIDTHS[THUMB_WIDTHS.length - 1];
    if (!svg && width >= w) { return original.source; }
    return thumb.source.replace(pattern, "/" + width + "px-$1");
  }

  var WIKIDATA = "https://www.wikidata.org/w/api.php?format=json&origin=*&";
  var VIDEO_GAME = "Q7889";

  function urlQuery(params) {
    return Object.keys(params).map(function (key) {
      return key + "=" + encodeURIComponent(params[key]);
    }).join("&");
  }

  function getJson(fetchFn, url, init) {
    return Promise.resolve().then(function () { return init ? fetchFn(url, init) : fetchFn(url); }).then(function (response) {
      if (!response.ok) { throw new Error("status " + response.status); }
      return response.json();
    });
  }

  function claimIds(entity, property) {
    return ((entity.claims || {})[property] || []).map(function (claim) {
      var value = claimValue(claim);
      return value && value.id;
    }).filter(Boolean);
  }

  // {thumb, image} of the lead image of the game's article (English, else French), or null
  // when there is none; a failed request is null too unless `strict` (then it rejects).
  function summaryImage(fetchFn, sitelinks, strict) {
    var link = sitelinks && (sitelinks.enwiki ? ["en", sitelinks.enwiki] : sitelinks.frwiki ? ["fr", sitelinks.frwiki] : null);
    if (!link || !link[1].title) { return Promise.resolve(null); }
    var url = "https://" + link[0] + ".wikipedia.org/api/rest_v1/page/summary/"
      + encodeURIComponent(link[1].title.replace(/ /g, "_"));
    return getJson(fetchFn, url).then(function (body) {
      var thumb = body.thumbnail && body.thumbnail.source;
      var image = listsCoverUrl(body);
      return thumb || image ? { thumb: thumb || image, image: image } : null;
    }, function (error) {
      if (strict) { throw error; }
      return null;
    });
  }

  // The lead image of a Wikidata game's article, found again from its id: {thumb, image}, null
  // when it has none; rejects when Wikidata or Wikipedia cannot be read.
  function listsWikiImage(fetchFn, qid) {
    return getJson(fetchFn, WIKIDATA + urlQuery({ action: "wbgetentities", ids: qid, props: "sitelinks" }))
      .then(function (body) {
        var entity = body.entities && body.entities[qid];
        return summaryImage(fetchFn, entity && entity.sitelinks, true);
      });
  }

  function earliestYear(entity) {
    var years = ((entity.claims || {}).P577 || []).map(function (claim) {
      var value = claimValue(claim);
      var m = /^\+?(\d{1,4})-/.exec(String((value && value.time) || ""));
      return m ? ("0000" + m[1]).slice(-4) : null;
    }).filter(Boolean).sort();
    return years.length ? years[0] : null;
  }

  // Wikipedia games matching the query: Wikidata items that are video games (P31 Q7889) with at
  // least one platform, in Wikidata's order, each {id, entity (with platformLabels, for
  // listsWikidataItem), title, year, platforms, thumb, image}. Rejects when Wikidata cannot be
  // reached; a missing thumbnail is only null.
  function listsSearchWikidata(fetchFn, text, lang) {
    // Full-text search, restricted to video games: words match in any order and anywhere in a
    // title or alias ("plague tale resonance" finds "Resonance: A Plague Tale Legacy"), which
    // the prefix-only wbsearchentities could not do.
    return getJson(fetchFn, WIKIDATA + urlQuery({
      action: "query", list: "search", srsearch: text + " haswbstatement:P31=" + VIDEO_GAME, srlimit: 10
    })).then(function (body) {
      var hits = (body.query && body.query.search) || [];
      var ids = hits.map(function (hit) { return hit.title; }).filter(function (id) {
        return typeof id === "string" && /^Q[0-9]+$/.test(id);
      });
      if (!ids.length) { return []; }
      return getJson(fetchFn, WIKIDATA + urlQuery({
        action: "wbgetentities", ids: ids.join("|"), props: "labels|claims|sitelinks", languages: "fr|en|mul"
      })).then(function (found) {
        var games = ids.map(function (id) { return (found.entities || {})[id]; }).filter(function (entity) {
          return entity && claimIds(entity, "P31").indexOf(VIDEO_GAME) >= 0 && claimIds(entity, "P400").length;
        });
        var platformIds = [];
        games.forEach(function (entity) {
          claimIds(entity, "P400").forEach(function (id) {
            if (platformIds.indexOf(id) < 0) { platformIds.push(id); }
          });
        });
        if (!games.length) { return []; }
        var batches = [];
        for (var at = 0; at < platformIds.length; at += 50) { batches.push(platformIds.slice(at, at + 50)); }
        return Promise.all(batches.map(function (batch) {
          return getJson(fetchFn, WIKIDATA + urlQuery({
            action: "wbgetentities", ids: batch.join("|"), props: "labels", languages: "fr|en|mul"
          }));
        })).then(function (pages) {
          var names = {};
          pages.forEach(function (labels) {
            Object.keys(labels.entities || {}).forEach(function (id) { names[id] = labels.entities[id].labels; });
          });
          return Promise.all(games.map(function (entity) {
            var withLabels = Object.assign({}, entity, { platformLabels: names });
            var picked;
            try { picked = listsWikidataItem(withLabels, lang, null); } catch (e) { return null; }
            return summaryImage(fetchFn, entity.sitelinks).then(function (image) {
              var title = picked.item.title;
              return { id: entity.id, entity: withLabels, title: title[lang] || title.fr || title.en,
                       year: earliestYear(entity), platforms: picked.platforms,
                       thumb: image ? image.thumb : null, image: image ? image.image : null };
            });
          }));
        });
      });
    }).then(function (results) { return results.filter(Boolean); });
  }


  // --- RAWG (rawg.io): a second source for the search. The key is RAWG's `key` query
  // parameter and goes to api.rawg.io only.
  var RAWG = "https://api.rawg.io/api/games";

  var RAWG_TIMEOUT_MS = 8000;

  // RAWG's 420 px copy of a media.rawg.io image (the search result thumbnails); the image
  // itself when its URL is not of the usual form.
  function rawgThumb(image) {
    if (!image) { return null; }
    var m = /^https:\/\/media\.rawg\.io\/media\/(?!resize\/|crop\/)(.+)$/.exec(image);
    return m ? "https://media.rawg.io/media/resize/420/-/" + m[1] : image;
  }

  // Run request(init) and reject after `ms` (aborting the request when the browser can).
  function withTimeout(request, ms) {
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (controller) { controller.abort(); }
        reject(new Error("timeout"));
      }, ms);
      Promise.resolve().then(function () { return request(controller ? { signal: controller.signal } : undefined); })
        .then(function (value) { clearTimeout(timer); resolve(value); },
              function (error) { clearTimeout(timer); reject(error); });
    });
  }

  // "YYYY-MM-DD" or "YYYY" as RAWG gives them, else null (not released yet).
  function rawgDate(released) {
    return /^\d{4}(-\d{2}-\d{2})?$/.test(String(released || "")) ? String(released) : null;
  }

  function rawgPlatformNames(game) {
    var names = [];
    (game.platforms || []).forEach(function (entry) {
      var name = entry && entry.platform && entry.platform.name;
      if (typeof name === "string" && name.trim() && names.indexOf(name.trim()) < 0) { names.push(name.trim()); }
    });
    return names;
  }

  // The list item for a RAWG game on the chosen platform (null when it lists none).
  function listsRawgItem(game, platformName) {
    return {
      rawg: String(game.id), title: { en: String(game.name).trim() },
      platform: platformName ? { en: String(platformName) } : null,
      date: rawgDate(game.released), cover: null
    };
  }

  // Games matching the query from RAWG, each {source: "rawg", id, slug, game, title, year,
  // platforms: [{value, label}], thumb, image} (thumb and image: its background_image, which
  // is also the cover's source). Rejects when RAWG answers an error or cannot be reached.
  function listsSearchRawg(fetchFn, text, key, timeoutMs) {
    return withTimeout(function (init) {
      return getJson(fetchFn, RAWG + "?" + urlQuery({ search: text, page_size: 10, key: key }), init);
    }, timeoutMs === undefined ? RAWG_TIMEOUT_MS : timeoutMs).then(function (body) {
      return ((body && body.results) || []).filter(function (game) {
        return game && game.id !== undefined && game.id !== null && /^\d+$/.test(String(game.id))
          && typeof game.name === "string" && game.name.trim();
      }).map(function (game) {
        var image = typeof game.background_image === "string" && game.background_image ? game.background_image : null;
        var date = rawgDate(game.released);
        return { source: "rawg", id: String(game.id), slug: game.slug ? String(game.slug) : null, game: game,
                 title: game.name.trim(), year: date ? date.slice(0, 4) : null,
                 platforms: rawgPlatformNames(game).map(function (name) { return { value: name, label: name }; }),
                 thumb: rawgThumb(image), image: image };
      });
    });
  }

  // {thumb, image} of a RAWG game's background image, found again from its id; null when it
  // has none; rejects when RAWG cannot be read.
  function listsRawgImage(fetchFn, id, key) {
    return getJson(fetchFn, RAWG + "/" + encodeURIComponent(id) + "?" + urlQuery({ key: key })).then(function (game) {
      var image = game && typeof game.background_image === "string" && game.background_image ? game.background_image : null;
      return image ? { thumb: rawgThumb(image), image: image } : null;
    });
  }

  // The RAWG ids and slugs a Wikidata result states (P9968).
  function rawgRefs(result) {
    var claims = ((result.entity && result.entity.claims) || {}).P9968 || [];
    return claims.map(function (claim) {
      var value = claimValue(claim);
      return typeof value === "string" || typeof value === "number" ? String(value) : null;
    }).filter(Boolean);
  }

  // Wikidata results first, then the RAWG ones whose id (or slug) is not the P9968 of a
  // Wikidata result shown; each marked with its `source`. Inputs are left untouched.
  function listsMergeResults(wikidataResults, rawgResults) {
    var known = {};
    var out = (wikidataResults || []).map(function (result) {
      rawgRefs(result).forEach(function (ref) { known[ref] = true; });
      return Object.assign({}, result, { source: "wikidata" });
    });
    (rawgResults || []).forEach(function (result) {
      if (!known[result.id] && !(result.slug && known[result.slug])) { out.push(Object.assign({}, result, { source: "rawg" })); }
    });
    return out;
  }

  // The centred 3:4 (portrait) part of a width x height image: {sx, sy, sw, sh}.
  function listsCropBox(width, height) {
    var sw, sh;
    if (width * 4 > height * 3) { sh = height; sw = Math.round(height * 3 / 4); }
    else { sw = width; sh = Math.round(width * 4 / 3); }
    return { sx: Math.round((width - sw) / 2), sy: Math.round((height - sh) / 2), sw: sw, sh: sh };
  }

  var api = {
    listsNew: listsNew, listsMerge: listsMerge, listsItemKey: listsItemKey,
    listsAdd: listsAdd, listsMove: listsMove, listsRemoveItem: listsRemoveItem,
    listsAddTier: listsAddTier, listsRemoveTier: listsRemoveTier,
    listsRename: listsRename, listsRelabel: listsRelabel,
    listsWikidataItem: listsWikidataItem, listsPendingView: listsPendingView,
    listsNewId: listsNewId, listsFindInCollection: listsFindInCollection,
    listsSaveCovers: listsSaveCovers, listsSearchWikidata: listsSearchWikidata,
    listsWikiImage: listsWikiImage, listsSetCovers: listsSetCovers,
    listsSaveTransform: listsSaveTransform, listsCoverUrl: listsCoverUrl,
    listsRawgItem: listsRawgItem, listsSearchRawg: listsSearchRawg, listsRawgImage: listsRawgImage,
    listsMergeResults: listsMergeResults, listsRawgThumb: rawgThumb, listsCropBox: listsCropBox
  };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.museumLists = api;
  if (typeof document === "undefined") { return; }

  // The page part: the lists index and list pages of a build with a notes target carry a
  // #lists-data block. Every visitor's browser shows the pages as built; a browser that saved
  // a list in the last hour shows its saved copy (the pending view); a browser holding the
  // notes token also gets the editor. Friends' browsers never contact Wikipedia: only the
  // editor and the pending view of the owner's browser show Wikimedia thumbnails.
  var TOKEN_KEY = "museum-github-token";
  var PENDING_KEY = "museum-lists-pending";
  var RAWG_KEY = "museum-rawg-key";
  var JPEG_QUALITY = 0.85;
  var TIER_NAMES = "SABCDEFGHIJ";
  var RESULTS = 8;            // collection matches shown before the Wikipedia ones

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

  function button(className, text, label) {
    var node = el("button", className, text);
    node.type = "button";
    if (label) { node.setAttribute("aria-label", label); node.title = label; }
    return node;
  }

  function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }

  function initPage(data) {
    var t = data.strings;
    var lang = document.documentElement.lang === "en" ? "en" : "fr";
    var fetchFn = root.fetch ? root.fetch.bind(root) : null;
    var section = document.querySelector(".tier-list, .lists");
    if (!section) { return; }
    var onListPage = !!data.list;
    var dataNode = document.getElementById("lists-data");
    var display = {};          // item key -> what the page shows for it
    var searchIndex = null;    // the collection's search entries, loaded with the editor
    var searchById = {};

    function pick(names) {
      names = names || {};
      return names[lang] || names.fr || names.en || "";
    }

    // "11 mars 1995" / "11 March 1995", like museum.site.i18n.format_date; a year alone as is.
    function formatDate(date) {
      var m = /^(\d{4})(?:-(\d{2})-(\d{2}))?$/.exec(date || "");
      if (!m) { return ""; }
      if (!m[2]) { return m[1]; }
      var month = new Date(Date.UTC(2000, Number(m[2]) - 1, 1))
        .toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", { month: "long", timeZone: "UTC" });
      var day = Number(m[3]);
      return (lang === "fr" && day === 1 ? "1er" : String(day)) + " " + month + " " + m[1];
    }

    function joined(parts) { return parts.filter(Boolean).join(" · "); }

    function wikiDisplay(item, image) {
      return { title: pick(item.title), meta: joined([pick(item.platform), formatDate(item.date)]),
               media: null, photo: null, thumb: image ? image.thumb : null,
               image: image ? image.image : null, href: null, owned: false };
    }

    function entryDisplay(entry) {
      return { title: entry.title, meta: joined([entry.console_name, entry.release]),
               media: entry.cover || null, photo: entry.image || null, thumb: null, image: null,
               href: entry.url || null, owned: true };
    }

    // What the built page shows for each of its games (read before anything is redrawn).
    Array.prototype.forEach.call(document.querySelectorAll(".tier-item[data-key]"), function (li) {
      var img = li.querySelector("img");
      var link = li.querySelector("a.tier-link");
      var media = img ? img.getAttribute("data-media") : null;
      display[li.getAttribute("data-key")] = {
        title: (li.querySelector(".tier-title") || {}).textContent || "",
        meta: (li.querySelector(".tier-meta") || {}).textContent || "",
        media: media, photo: img ? (img.getAttribute(media ? "data-fallback" : "src") || null) : null,
        thumb: null, image: null, href: link ? link.getAttribute("href") : null,
        owned: !li.querySelector(".not-owned")
      };
    });

    function displayOf(item) {
      var key = listsItemKey(item);
      if (display[key]) { return display[key]; }
      var found;
      if (item.offer === undefined) { found = wikiDisplay(item, null); }
      else if (searchById[item.offer]) { found = entryDisplay(searchById[item.offer]); }
      else { // no longer in the collection: shown like a Wikipedia game without cover or link
        found = { title: typeof item.title === "string" ? item.title : pick(item.title), meta: "",
                  media: null, photo: null, thumb: null, image: null, href: null, owned: false };
        if (searchIndex === null) { return found; } // not known yet: do not remember it
      }
      display[key] = found;
      return found;
    }

    function coverNode(d, className) {
      var box = el("span", className || "tier-cover");
      var img = null;
      if (d.media) {
        img = el("img");
        img.setAttribute("data-media", d.media);
        if (d.photo) { img.setAttribute("data-fallback", d.photo); }
      } else if (d.photo || d.thumb) {
        img = el("img");
        if (!d.photo) { img.referrerPolicy = "no-referrer"; } // a Wikimedia thumbnail
        img.src = d.photo || d.thumb;
        img.loading = "lazy";
      }
      if (img) {
        img.alt = t.cover_of + " " + d.title;
        box.appendChild(img);
      } else {
        box.appendChild(el("span", "tier-cover-missing"));
      }
      return box;
    }

    function notOwnedMark() {
      var mark = el("span", "not-owned", "◇");
      mark.title = t.not_in_collection;
      return mark;
    }

    function loadMedia(node) { if (root.museumLoadMedia) { root.museumLoadMedia(node); } }

    // ---- the page as built, or as saved from this browser in the last hour ----

    function viewItem(item) {
      var d = displayOf(item);
      var li = el("li", "tier-item");
      li.setAttribute("data-key", listsItemKey(item));
      var link = el(d.href ? "a" : "span", "tier-link");
      if (d.href) { link.href = d.href; }
      link.appendChild(coverNode(d));
      link.appendChild(el("span", "tier-title", d.title));
      link.appendChild(el("span", "tier-meta", d.meta));
      li.appendChild(link);
      if (!d.owned) { li.appendChild(notOwnedMark()); }
      return li;
    }

    function showList(list) {
      var h1 = section.querySelector("h1");
      if (h1) { h1.textContent = list.title; }
      document.title = list.title + document.title.slice(document.title.lastIndexOf(" · "));
      Array.prototype.forEach.call(section.querySelectorAll(":scope > section.tier"), function (node) {
        node.remove();
      });
      list.tiers.forEach(function (tier, index) {
        var row = el("section", "tier");
        row.setAttribute("data-tier-index", String(index));
        row.appendChild(el("h2", "tier-label", tier.label));
        var ul = el("ul", "tier-items");
        tier.items.forEach(function (item) { ul.appendChild(viewItem(item)); });
        row.appendChild(ul);
        section.insertBefore(row, dataNode);
      });
      loadMedia(section);
    }

    var deleted = false;

    function showDeleted() {
      deleted = true;
      Array.prototype.forEach.call(section.querySelectorAll(":scope > section.tier"), function (node) {
        node.remove();
      });
      if (!section.querySelector(".lists-deleted")) {
        var note = el("p", "muted lists-deleted", t.lists_deleted);
        note.setAttribute("role", "status");
        section.insertBefore(note, dataNode);
      }
    }

    function countText(list) {
      var n = list.tiers.reduce(function (sum, tier) { return sum + tier.items.length; }, 0);
      return format(n === 1 ? t.lists_count_one : t.lists_count, { n: n });
    }

    function fillCard(card, list) {
      card.replaceChildren();
      var covers = el("span", "list-card-covers");
      (list.tiers[0] ? list.tiers[0].items : []).map(displayOf).filter(function (d) {
        return d.media || d.photo || d.thumb;
      }).slice(0, 5).forEach(function (d) { covers.appendChild(coverNode(d, "list-card-cover")); });
      card.appendChild(covers);
      card.appendChild(el("span", "list-card-title", list.title));
      card.appendChild(el("span", "list-card-count", countText(list)));
    }

    function cardsList() {
      var ul = section.querySelector(".list-cards");
      if (!ul) {
        ul = el("ul", "list-cards");
        section.insertBefore(ul, section.querySelector(".lists-empty") || dataNode);
      }
      return ul;
    }

    // The index: hide lists deleted from here, update saved ones, add new ones first (newest
    // first); a new list has no page before the rebuild, so its card opens the editor.
    function showIndex(pending, view) {
      var shown = {};
      view.forEach(function (list) { shown[list.id] = list; });
      var built = {};
      Array.prototype.forEach.call(section.querySelectorAll(".list-cards > li[data-list-id]"), function (li) {
        var id = li.getAttribute("data-list-id");
        if (li.classList.contains("list-pending")) { li.remove(); return; }
        built[id] = true;
        li.hidden = !shown[id];
        if (shown[id] && shown[id].tiers) { fillCard(li.querySelector(".list-card"), shown[id]); }
      });
      var fresh = view.filter(function (list) { return !built[list.id] && list.tiers; });
      fresh.sort(function (a, b) { return pending[a.id].savedAt - pending[b.id].savedAt; });
      fresh.forEach(function (list) {
        var li = el("li", "list-pending");
        li.setAttribute("data-list-id", list.id);
        var card = button("list-card");
        fillCard(card, list);
        card.addEventListener("click", function () { if (owner) { owner.open(list.id); } });
        li.appendChild(card);
        var ul = cardsList();
        ul.insertBefore(li, ul.firstChild);
      });
      var any = Array.prototype.some.call(section.querySelectorAll(".list-cards > li"), function (li) {
        return !li.hidden;
      });
      var empty = section.querySelector(".lists-empty");
      if (empty) { empty.hidden = any; }
      loadMedia(section);
    }

    function refreshView() {
      var now = Date.now();
      var pending = readPending();
      Object.keys(pending).forEach(function (id) { // forget what the rebuild has published
        var entry = pending[id];
        if (!entry || typeof entry.savedAt !== "number" || now - entry.savedAt > PENDING_MS) { delete pending[id]; }
      });
      writePending(pending);
      Object.keys(pending).forEach(function (id) {
        var shown = (pending[id] && pending[id].display) || {};
        Object.keys(shown).forEach(function (key) { display[key] = shown[key]; });
      });
      if (onListPage) {
        var mine = listsPendingView(pending, [{ id: data.list }], now).filter(function (list) {
          return list.id === data.list; // the view also holds other lists saved from here
        });
        if (!mine.length) { showDeleted(); } else if (mine[0].tiers) { showList(mine[0]); }
      } else {
        var built = Array.prototype.map.call(section.querySelectorAll(".list-cards > li[data-list-id]:not(.list-pending)"),
          function (li) { return { id: li.getAttribute("data-list-id") }; });
        showIndex(pending, listsPendingView(pending, built, now));
      }
    }

    refreshView();

    // ---- the owner's controls: only in a browser holding the notes token ----

    var owner = null;
    if (!readStore(TOKEN_KEY) || !fetchFn) { return; }
    owner = initEditor();

    function initEditor() {
      var target = { repo: data.repo, branch: data.branch, path: data.path };
      var bar = el("div", "lists-owner");
      var tools = el("div", "notes-buttons lists-owner-buttons");
      var message = el("p", "notes-message lists-message");
      message.setAttribute("role", "status");
      message.setAttribute("aria-live", "polite");
      var edit = button("notes-edit", onListPage ? t.notes_edit : t.lists_new);
      tools.appendChild(edit);
      var remove = null;
      if (onListPage) {
        remove = button("notes-edit lists-delete", t.lists_delete);
        tools.appendChild(remove);
      }
      bar.appendChild(tools);
      bar.appendChild(message);
      var h1 = section.querySelector("h1");
      section.insertBefore(bar, h1 ? h1.nextSibling : section.firstChild);
      tools.hidden = deleted;
      var editor = null;

      function say(text, kind) {
        message.textContent = text;
        message.classList.toggle("notes-error", kind === "error");
        message.classList.toggle("lists-warn", kind === "warn");
      }

      function errorText(result) {
        if (result.error === "token" || result.error === "network" || result.error === "conflict") {
          return t["notes_error_" + result.error];
        }
        return format(t.notes_error_other, { code: result.code === undefined ? "?" : result.code });
      }

      function busy(on) {
        edit.disabled = on;
        if (remove) { remove.disabled = on; }
      }

      function storePending(id, entry) {
        var all = readPending();
        all[id] = entry;
        writePending(all);
      }

      function open(listId) {
        var token = readStore(TOKEN_KEY);
        if (!token) { say(t.notes_error_token, "error"); return; }
        busy(true);
        say(t.lists_loading);
        var index = root.museumLoadJson ? root.museumLoadJson(data.search).then(null, function () { return []; })
          : Promise.resolve([]);
        Promise.all([notes.notesReadJson(fetchFn, target, token), index]).then(function (got) {
          busy(false);
          var read = got[0];
          if (!read.ok) { say(errorText(read), "error"); return; }
          searchIndex = Array.isArray(got[1]) ? got[1] : [];
          searchIndex.forEach(function (entry) { searchById[entry.id] = entry; });
          var lists = read.file && Array.isArray(read.file.lists) ? read.file.lists : [];
          var found = null;
          lists.forEach(function (list) { if (list.id === listId) { found = list; } });
          if (listId && !found) { say(format(t.notes_error_other, { code: 404 }), "error"); return; }
          if (!found && lists.length >= MAX_LISTS) { say(t.lists_too_many, "error"); return; }
          var list = found ? clone(found) : listsNew(listsNewId(function (n) {
            return root.crypto.getRandomValues(new Uint8Array(n));
          }, lists.map(function (other) { return other.id; })), t.lists_new);
          if (!Array.isArray(list.unplaced)) { list.unplaced = []; }
          say("");
          editor = buildEditor(list);
        }).then(null, function () { // never leave "Loading…" up
          busy(false);
          say(format(t.notes_error_other, { code: "?" }), "error");
        });
      }

      function close() {
        if (editor) { editor.remove(); editor = null; }
        section.classList.remove("lists-editing");
        tools.hidden = deleted;
        refreshView();
        edit.focus();
      }

      edit.addEventListener("click", function () { open(onListPage ? data.list : null); });

      if (remove) {
        remove.addEventListener("click", function () {
          var title = (section.querySelector("h1") || {}).textContent || data.title;
          if (!root.confirm(format(t.lists_delete_confirm, { title: title }))) { return; }
          var token = readStore(TOKEN_KEY);
          if (!token) { say(t.notes_error_token, "error"); return; }
          busy(true);
          say(t.notes_saving);
          var stamp = nowIso();
          notes.notesPutJson(fetchFn, target, token, function (file) {
            return listsMerge(file, null, data.list, stamp);
          }, "chore: delete list " + title).then(function (result) {
            busy(false);
            if (!result.ok) { say(errorText(result), "error"); return; }
            storePending(data.list, { savedAt: Date.now(), deleted: true });
            say("");
            showDeleted();
            tools.hidden = true;
          });
        });
      }

      // A cover for the repository: the article's lead image shrunk to COVER_SIDE in a canvas
      // (Wikimedia allows anonymous cross-origin reads, so the canvas can be exported).
      function shrinkCover(url, crop) {
        return new Promise(function (resolve, reject) {
          var img = new Image();
          img.crossOrigin = "anonymous";
          img.referrerPolicy = "no-referrer";
          img.onload = function () {
            try {
              var w = img.naturalWidth, h = img.naturalHeight;
              if (!w || !h) { throw new Error("size"); }
              // RAWG's landscape artwork is first cut to the tile's portrait shape (3:4).
              var box = crop ? listsCropBox(w, h) : { sx: 0, sy: 0, sw: w, sh: h };
              var scale = Math.min(1, COVER_SIDE / Math.max(box.sw, box.sh));
              var canvas = document.createElement("canvas");
              canvas.width = Math.max(1, Math.round(box.sw * scale));
              canvas.height = Math.max(1, Math.round(box.sh * scale));
              var context = canvas.getContext("2d");
              context.fillStyle = "#fff"; // JPEG has no transparency
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.drawImage(img, box.sx, box.sy, box.sw, box.sh, 0, 0, canvas.width, canvas.height);
              canvas.toBlob(function (blob) {
                if (!blob) { reject(new Error("encode")); return; }
                var reader = new FileReader();
                reader.onload = function () { resolve(String(reader.result).split(",")[1]); };
                reader.onerror = function () { reject(new Error("read")); };
                reader.readAsDataURL(blob);
              }, "image/jpeg", JPEG_QUALITY);
            } catch (e) { reject(e); }
          };
          img.onerror = function () { reject(new Error("load")); };
          img.src = url;
        });
      }

      function makeCover(id) {
        var rawgId = /^rawg-(\d+)$/.exec(id);
        if (rawgId) { // RAWG artwork, found again with the key when the page does not hold it
          var shown = display["rawg:" + rawgId[1]];
          var key = readStore(RAWG_KEY);
          var wanted = shown && shown.image ? Promise.resolve({ image: shown.image })
            : key ? listsRawgImage(fetchFn, rawgId[1], key) : Promise.resolve(null);
          return wanted.then(function (found) { return found && found.image ? shrinkCover(found.image, true) : null; });
        }
        var qid = id;
        var known = display["wikidata:" + qid];
        var image = known && known.image ? Promise.resolve({ image: known.image }) : listsWikiImage(fetchFn, qid);
        return image.then(function (found) { return found && found.image ? shrinkCover(found.image) : null; });
      }

      function buildEditor(start) {
        var state = { list: start, selected: null };
        var focusAfter = null;   // {key, action} to focus once the tiers are redrawn
        var dragKey = null;
        var imageRequests = {};
        var form = el("form", "lists-editor");

        var titleLabel = el("label", "notes-label", t.lists_name);
        titleLabel.htmlFor = "lists-title";
        var title = el("input");
        title.id = "lists-title";
        title.type = "text";
        title.required = true;
        title.maxLength = MAX_TITLE;
        title.pattern = ".*\\S.*";
        title.value = start.title;
        title.addEventListener("input", function () {
          try { state.list = listsRename(state.list, title.value); } catch (e) { /* kept until valid */ }
        });

        var search = el("div", "lists-search");
        var query = el("input");
        query.type = "search";
        query.placeholder = t.lists_search;
        query.setAttribute("aria-label", t.lists_search);
        query.autocomplete = "off";
        var results = el("ul", "lists-results");
        var note = el("p", "muted lists-search-note");   // RAWG failure note
        note.hidden = true;
        search.appendChild(query);
        search.appendChild(note);
        search.appendChild(results);
        if (readStore(RAWG_KEY)) { // RAWG asks for a link; shown only where its data is searched
          var credit = el("p", "muted lists-credit");
          var link = el("a", "", t.lists_rawg_credit);
          link.href = "https://rawg.io";
          link.rel = "noopener noreferrer";
          link.target = "_blank";
          credit.appendChild(link);
          search.appendChild(credit);
        }

        // The ranked tiers on the left; "À classer" beside them on the right on wide screens (it
        // stays in view while games are dragged into the tiers), below them on narrow ones.
        var board = el("div", "lists-board");
        var ranked = el("div", "lists-ranked");
        var tiers = el("div", "lists-tiers");
        var side = el("div", "lists-side");
        var addTier = button("notes-edit lists-add-tier", t.lists_add_tier);
        ranked.appendChild(tiers);
        ranked.appendChild(addTier);
        board.appendChild(ranked);
        board.appendChild(side);
        var actions = el("div", "notes-buttons");
        var save = el("button", "notes-save", t.notes_save);
        save.type = "submit";
        var cancel = button("notes-cancel", t.notes_cancel);
        actions.appendChild(save);
        actions.appendChild(cancel);
        [titleLabel, title, search, board, actions].forEach(function (node) { form.appendChild(node); });

        function itemCount() {
          return state.list.tiers.reduce(function (sum, tier) { return sum + tier.items.length; },
                                         state.list.unplaced.length);
        }

        function tierItems(tier) { return tier === "unplaced" ? state.list.unplaced : state.list.tiers[tier].items; }

        function neighbour(tier, step) {
          var order = state.list.tiers.map(function (x, i) { return i; }).concat(["unplaced"]);
          var at = order.indexOf(tier) + step;
          return at >= 0 && at < order.length ? order[at] : null;
        }

        // Position of `key` in a tier once `moving` has been taken out of it.
        function positionOf(tier, key, moving) {
          return tierItems(tier).filter(function (item) { return listsItemKey(item) !== moving; })
            .map(listsItemKey).indexOf(key);
        }

        function move(key, tier, at, action) {
          state.list = listsMove(state.list, key, tier, at);
          focusAfter = { key: key, action: action || "pick" };
          draw();
        }

        function ensureImage(item, d) {
          var id = coverId(item);
          if (!id || d.media || d.photo || d.thumb || imageRequests[id]) { return; }
          var rawgKey = item.rawg !== undefined ? readStore(RAWG_KEY) : null;
          if (item.rawg !== undefined && !rawgKey) { return; } // no key: the placeholder stays
          imageRequests[id] = (item.rawg !== undefined ? listsRawgImage(fetchFn, item.rawg, rawgKey)
                                                       : listsWikiImage(fetchFn, item.wikidata)).then(function (found) {
            if (!found) { return; }
            d.thumb = found.thumb;
            d.image = found.image;
            Array.prototype.forEach.call(board.querySelectorAll("li[data-key]"), function (li) {
              if (li.getAttribute("data-key") !== listsItemKey(item)) { return; }
              var old = li.querySelector(".tier-cover");
              if (old) { old.replaceWith(coverNode(d)); }
            });
          }, function () { /* placeholder stays */ });
        }

        function removeGame(key) {
          state.list = listsRemoveItem(state.list, key);
          if (state.selected === key) { state.selected = null; }
          draw();
          query.focus();
        }

        function editItem(item, tier, at, count) {
          var key = listsItemKey(item);
          var d = displayOf(item);
          ensureImage(item, d);
          var selected = state.selected === key;
          var li = el("li", "tier-item lists-item" + (selected ? " lists-selected" : ""));
          li.setAttribute("data-key", key);
          li.draggable = true;
          // A focusable span, not a <button>: Firefox starts no drag from a button.
          var pickButton = el("span", "lists-pick");
          pickButton.tabIndex = 0;
          pickButton.setAttribute("role", "button");
          pickButton.setAttribute("aria-pressed", String(selected));
          pickButton.appendChild(coverNode(d));
          pickButton.appendChild(el("span", "tier-title", d.title));
          pickButton.appendChild(el("span", "tier-meta", d.meta));
          Array.prototype.forEach.call(pickButton.querySelectorAll("img"), function (img) { img.draggable = false; });
          pickButton.addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pickButton.click(); }
          });
          pickButton.addEventListener("click", function () {
            if (state.selected && state.selected !== key) { // put the selected game here
              var moving = state.selected;
              state.selected = null;
              move(moving, tier, positionOf(tier, key, moving));
              return;
            }
            state.selected = selected ? null : key;
            focusAfter = { key: key, action: "pick" };
            draw();
          });
          li.appendChild(pickButton);
          if (!d.owned) { li.appendChild(notOwnedMark()); }
          // Always-visible remove button in the cover's corner (the tool bar below a selected
          // game has one too, for the keyboard).
          var drop = button("lists-remove-item", "×", t.lists_remove_game + " — " + d.title);
          drop.draggable = false;
          drop.addEventListener("click", function (event) {
            event.stopPropagation();
            removeGame(key);
          });
          li.appendChild(drop);
          if (selected) {
            var bar = el("div", "lists-tools");
            [["left", "←", t.lists_move_left, at > 0, function () { move(key, tier, at - 1, "left"); }],
             ["right", "→", t.lists_move_right, at < count - 1, function () { move(key, tier, at + 1, "right"); }],
             ["up", "↑", t.lists_move_up, neighbour(tier, -1) !== null,
              function () { move(key, neighbour(tier, -1), at, "up"); }],
             ["down", "↓", t.lists_move_down, neighbour(tier, 1) !== null,
              function () { move(key, neighbour(tier, 1), at, "down"); }],
             ["remove", "×", t.lists_remove_game, true, function () { removeGame(key); }]].forEach(function (spec) {
              var tool = button("lists-tool", spec[1], spec[2]);
              tool.setAttribute("data-action", spec[0]);
              tool.disabled = !spec[3];
              tool.addEventListener("click", spec[4]);
              bar.appendChild(tool);
            });
            li.appendChild(bar);
          }
          li.addEventListener("dragstart", function (event) {
            dragKey = key;
            event.dataTransfer.effectAllowed = "move";
            try { event.dataTransfer.setData("text/plain", key); } catch (e) { /* old browsers */ }
            li.classList.add("lists-dragging");
          });
          li.addEventListener("dragend", function () {
            dragKey = null;
            li.classList.remove("lists-dragging");
          });
          return li;
        }

        // Where a dragged game lands among a row's covers (which wrap on several lines).
        function dropIndex(ul, key, x, y) {
          var at = 0;
          var items = ul.querySelectorAll(":scope > li[data-key]");
          for (var i = 0; i < items.length; i++) {
            if (items[i].getAttribute("data-key") === key) { continue; }
            var r = items[i].getBoundingClientRect();
            if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) { return at; }
            at += 1;
          }
          return at;
        }

        function tierRow(tier) {
          var row = el("section", "tier lists-tier" + (tier === "unplaced" ? " lists-unplaced" : ""));
          row.setAttribute("data-tier", String(tier));
          var head = el("div", "tier-label");
          if (tier === "unplaced") {
            head.appendChild(el("span", "", t.lists_unplaced));
          } else {
            var name = el("input", "lists-tier-name");
            name.type = "text";
            name.required = true;
            name.maxLength = MAX_LABEL;
            name.pattern = ".*\\S.*";
            name.value = state.list.tiers[tier].label;
            name.setAttribute("aria-label", t.lists_tier_name);
            name.addEventListener("input", function () {
              try { state.list = listsRelabel(state.list, tier, name.value); } catch (e) { /* kept until valid */ }
            });
            head.appendChild(name);
            if (state.list.tiers.length > 1) {
              var drop = button("lists-tool lists-remove-tier", "×", t.lists_remove_tier);
              drop.addEventListener("click", function () {
                state.list = listsRemoveTier(state.list, tier);
                draw();
                addTier.focus();
              });
              head.appendChild(drop);
            }
          }
          var ul = el("ul", "tier-items");
          var items = tierItems(tier);
          items.forEach(function (item, at) { ul.appendChild(editItem(item, tier, at, items.length)); });
          row.addEventListener("click", function (event) { // tap a row to put the selected game at its end
            if (!state.selected || event.target.closest("input, button, li, select")) { return; }
            var moving = state.selected;
            state.selected = null;
            move(moving, tier, tierItems(tier).length);
          });
          ul.addEventListener("dragover", function (event) {
            if (!dragKey) { return; }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            row.classList.add("lists-drop");
          });
          ul.addEventListener("dragleave", function (event) {
            if (!ul.contains(event.relatedTarget)) { row.classList.remove("lists-drop"); }
          });
          ul.addEventListener("drop", function (event) {
            event.preventDefault();
            row.classList.remove("lists-drop");
            var key = dragKey;
            dragKey = null;
            if (key) { move(key, tier, dropIndex(ul, key, event.clientX, event.clientY)); }
          });
          row.appendChild(head);
          row.appendChild(ul);
          return row;
        }

        function draw() {
          tiers.replaceChildren();
          state.list.tiers.forEach(function (x, index) { tiers.appendChild(tierRow(index)); });
          side.replaceChildren(tierRow("unplaced"));
          addTier.disabled = state.list.tiers.length >= MAX_TIERS;
          loadMedia(board);
          if (focusAfter) {
            var wanted = focusAfter;
            focusAfter = null;
            Array.prototype.forEach.call(board.querySelectorAll("li[data-key]"), function (li) {
              if (li.getAttribute("data-key") !== wanted.key) { return; }
              var tool = li.querySelector('[data-action="' + wanted.action + '"]');
              (tool && !tool.disabled ? tool : li.querySelector(".lists-pick")).focus();
            });
          }
        }

        function add(item, d) {
          var key = listsItemKey(item);
          var result = listsAdd(state.list, item);
          if (!result.added) { // already in the list, or full
            if (itemCount() >= MAX_ITEMS) { say(t.lists_full, "error"); }
            return;
          }
          if (!display[key]) { display[key] = d; }
          state.list = result.list;
          say("");
          draw();
        }

        function resultButton(d, metaText, owned) {
          var pickButton = button("lists-result-pick");
          pickButton.appendChild(coverNode(d, "lists-result-cover"));
          var text = el("span", "lists-result-text");
          text.appendChild(el("span", "lists-result-title", d.title));
          var meta = el("span", "lists-result-meta", metaText);
          if (owned) { meta.appendChild(el("span", "lists-in-collection", (metaText ? " · " : "") + t.in_collection)); }
          text.appendChild(meta);
          pickButton.appendChild(text);
          return pickButton;
        }

        function collectionResult(entry) {
          var li = el("li", "lists-result");
          var d = entryDisplay(entry);
          var pickButton = resultButton(d, d.meta, true);
          pickButton.addEventListener("click", function () { add({ offer: entry.id, title: entry.title }, d); });
          li.appendChild(pickButton);
          return li;
        }

        // A Wikidata or RAWG result, marked with its source; the click adds the game.
        function wikiResult(found) {
          var li = el("li", "lists-result");
          var choice = null;
          var isRawg = found.source === "rawg";
          var preview = { title: found.title, meta: "", media: null, photo: null, thumb: found.thumb,
                          image: found.image, href: null, owned: false };
          var pickButton = resultButton(preview, found.year || "", false);
          pickButton.querySelector(".lists-result-meta").appendChild(
            el("span", "lists-source lists-source-" + found.source,
               (found.year ? " · " : "") + (isRawg ? t.lists_source_rawg : t.lists_source_wikidata)));
          li.appendChild(pickButton);
          if (found.platforms.length > 1) {
            var label = el("label", "lists-platform");
            label.appendChild(el("span", "notes-label", t.lists_platform + " "));
            choice = el("select");
            found.platforms.forEach(function (platform) {
              choice.appendChild(new Option(platform.label, isRawg ? platform.value : platform.qid));
            });
            label.appendChild(choice);
            li.appendChild(label);
          }
          pickButton.addEventListener("click", function () {
            var item;
            if (isRawg) {
              item = listsRawgItem(found.game, choice ? choice.value : found.platforms.length ? found.platforms[0].value : null);
            } else { item = listsWikidataItem(found.entity, lang, choice ? choice.value : null).item; }
            add(item, wikiDisplay(item, found));
          });
          return li;
        }

        var searchRun = 0;
        var searchTimer = null;
        query.addEventListener("keydown", function (event) {
          if (event.key === "Enter") { event.preventDefault(); } // Enter must not save the list
        });
        query.addEventListener("input", function () {
          var text = query.value.trim();
          var run = ++searchRun;
          clearTimeout(searchTimer);
          results.replaceChildren();
          note.hidden = true;
          if (fold(text).length < 2) { return; }
          listsFindInCollection(searchIndex, text, RESULTS).forEach(function (entry) {
            results.appendChild(collectionResult(entry));
          });
          loadMedia(results);
          searchTimer = setTimeout(function () {
            // Wikidata's results show as soon as they arrive; with a key RAWG is searched in
            // parallel and its results not already among Wikidata's are appended when it
            // settles (a slow or hanging RAWG never holds the others back, and the rows
            // already shown are left alone). Either failing leaves the other's results.
            var key = readStore(RAWG_KEY);
            function append(found) {
              found.forEach(function (game) { results.appendChild(wikiResult(game)); });
            }
            var wikidata = listsSearchWikidata(fetchFn, text, lang).then(null, function () { return []; });
            wikidata.then(function (found) { if (run === searchRun) { append(listsMergeResults(found, null)); } });
            if (!key) { return; }
            var refused = false;
            Promise.all([wikidata, listsSearchRawg(fetchFn, text, key).then(null, function (error) {
              refused = !!error && (error.message === "status 401" || error.message === "status 403");
              return null;
            })]).then(function (both) {
              if (run !== searchRun) { return; }
              if (both[1] === null) {
                note.textContent = refused ? t.lists_rawg_refused : t.lists_rawg_failed;
                note.hidden = false;
                return;
              }
              append(listsMergeResults(both[0], both[1]).filter(function (game) { return game.source === "rawg"; }));
            });
          }, 350);
        });

        addTier.addEventListener("click", function () {
          var used = state.list.tiers.map(function (tier) { return tier.label; });
          var label = TIER_NAMES.split("").filter(function (c) { return used.indexOf(c) < 0; })[0]
            || String(state.list.tiers.length + 1);
          state.list = listsAddTier(state.list, label);
          draw();
          var names = tiers.querySelectorAll(".lists-tier-name");
          names[names.length - 1].select();
        });

        cancel.addEventListener("click", function () { say(""); close(); });

        function pendingDisplay(list) {
          var shown = {};
          list.tiers.forEach(function (tier) {
            tier.items.forEach(function (item) {
              var d = displayOf(item);
              shown[listsItemKey(item)] = { title: d.title, meta: d.meta, media: d.media, photo: d.photo,
                                            thumb: d.thumb, image: null, href: d.href, owned: d.owned };
            });
          });
          return shown;
        }

        form.addEventListener("submit", function (event) {
          event.preventDefault();
          var token = readStore(TOKEN_KEY);
          if (!token) { say(t.notes_error_token, "error"); return; }
          save.disabled = cancel.disabled = true;
          say(t.notes_saving);
          var flags = {};
          var covers = { repo: data.repo, branch: data.branch, covers: data.covers };
          // The editor stays usable during the save: only the stored cover paths are merged
          // into the list as it is now, and the lists file gets the list as it is then.
          listsSaveCovers(fetchFn, covers, token, state.list, makeCover).then(function (stored) {
            state.list = listsSetCovers(state.list, stored.stored); // stay set even if the PUT fails
            var saved = clone(state.list);
            saved.updated = nowIso();
            return notes.notesPutJson(fetchFn, target, token, listsSaveTransform(saved, saved.updated, flags),
                                      "chore: update list " + saved.title).then(function (result) {
              return { result: result, saved: saved, failed: stored.failed };
            });
          }).then(function (done) {
            save.disabled = cancel.disabled = false;
            if (!done.result.ok) { // the editor keeps everything
              say(flags.limit ? t.lists_too_many : errorText(done.result), "error");
              return;
            }
            storePending(done.saved.id, { savedAt: Date.now(), list: done.saved,
                                          display: pendingDisplay(done.saved) });
            if (done.failed.length) { say(t.notes_saved + " · " + t.lists_cover_failed, "warn"); }
            else { say(t.notes_saved); }
          }).then(null, function () { // never leave the buttons disabled
            save.disabled = cancel.disabled = false;
            say(format(t.notes_error_other, { code: "?" }), "error");
          });
        });

        section.classList.add("lists-editing");
        tools.hidden = true;
        section.insertBefore(form, bar.nextSibling);
        draw();
        title.focus();
        return form;
      }

      return { open: open };
    }
  }

  var node = document.getElementById("lists-data");
  if (node) { initPage(JSON.parse(node.textContent)); }
})(typeof window !== "undefined" ? window : globalThis);
