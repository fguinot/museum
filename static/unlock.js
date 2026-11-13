(function (root) {
  "use strict";

  var STORE_KEY = "museum-key";

  function fromB64(text) {
    var bin = atob(text);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
    return out;
  }

  function toB64(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]); }
    return btoa(bin);
  }

  function deriveKeyBytes(password, payload) {
    var subtle = root.crypto.subtle;
    return subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"])
      .then(function (material) {
        return subtle.deriveBits(
          { name: "PBKDF2", hash: "SHA-256", salt: fromB64(payload.salt), iterations: payload.iter },
          material, 256);
      })
      .then(function (bits) { return new Uint8Array(bits); });
  }

  function decryptWithKeyBytes(keyBytes, payload) {
    var subtle = root.crypto.subtle;
    return subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"])
      .then(function (key) {
        return subtle.decrypt({ name: "AES-GCM", iv: fromB64(payload.iv) }, key, fromB64(payload.ct));
      })
      .then(function (plain) { return new TextDecoder().decode(plain); });
  }

  // Images are zero-padded before encryption; a WebP declares its own length in its
  // RIFF header ("RIFF", uint32 little-endian length - 8, "WEBP"). Anything else is kept.
  function trimWebp(bytes) {
    var tag = function (start) {
      return String.fromCharCode(bytes[start], bytes[start + 1], bytes[start + 2], bytes[start + 3]);
    };
    if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WEBP") { return bytes; }
    var total = 8 + bytes[4] + bytes[5] * 256 + bytes[6] * 65536 + bytes[7] * 16777216;
    return total <= bytes.length ? bytes.subarray(0, total) : bytes;
  }

  // File bytes are iv(12) || ciphertext+tag; the plaintext is a zero-padded image.
  function decryptBytesWithKeyBytes(keyBytes, bytes) {
    var subtle = root.crypto.subtle;
    return subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"])
      .then(function (key) {
        return subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
      })
      .then(function (plain) { return trimWebp(new Uint8Array(plain)); });
  }

  function readStored() {
    var stores = ["sessionStorage", "localStorage"];
    for (var i = 0; i < stores.length; i++) {
      try {
        var raw = root[stores[i]].getItem(STORE_KEY);
        if (raw) { return JSON.parse(raw); }
      } catch (e) { /* storage unavailable or corrupt */ }
    }
    return null;
  }

  function forgetStored() {
    ["sessionStorage", "localStorage"].forEach(function (name) {
      try { root[name].removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    });
  }

  function store(keyBytes, payload, remember) {
    var value = JSON.stringify({ key: toB64(keyBytes), salt: payload.salt });
    try { root.sessionStorage.setItem(STORE_KEY, value); } catch (e) { /* ignore */ }
    if (remember) {
      try { root.localStorage.setItem(STORE_KEY, value); } catch (e) { /* ignore */ }
    }
  }

  // Decrypt a payload with the key stored by the unlock page (used for the search data).
  function museumDecrypt(payload) {
    var stored = readStored();
    if (!stored || stored.salt !== payload.salt) {
      return Promise.reject(new Error("no key"));
    }
    return Promise.resolve().then(function () {
      return decryptWithKeyBytes(fromB64(stored.key), payload);
    });
  }

  // Decrypt an encrypted file (an image) with the stored key.
  function museumDecryptBytes(bytes) {
    var stored = readStored();
    if (!stored) { return Promise.reject(new Error("no key")); }
    return Promise.resolve().then(function () {
      return decryptBytesWithKeyBytes(fromB64(stored.key), bytes);
    });
  }

  // Same rule as the root redirect: stored choice, else the browser language.
  function rootLanguage(stored, navigatorLanguage) {
    if (stored === "fr" || stored === "en") { return stored; }
    return (navigatorLanguage || "").toLowerCase().indexOf("fr") === 0 ? "fr" : "en";
  }

  var api = {
    rootLanguage: rootLanguage,
    deriveKeyBytes: deriveKeyBytes,
    decryptWithKeyBytes: decryptWithKeyBytes,
    decryptBytesWithKeyBytes: decryptBytesWithKeyBytes,
    trimWebp: trimWebp,
    fromB64: fromB64,
    toB64: toB64
  };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (typeof document === "undefined") { return; }
  root.museumDecrypt = museumDecrypt;
  root.museumDecryptBytes = museumDecryptBytes;

  var payloadNode = document.getElementById("payload");
  if (!payloadNode || !document.body.hasAttribute("data-museum-locked")) { return; }
  var payload = JSON.parse(payloadNode.textContent);
  if (document.body.hasAttribute("data-root")) {
    var stored_lang = null;
    try { stored_lang = root.localStorage.getItem("lang"); } catch (e) { /* ignore */ }
    var chosen = rootLanguage(stored_lang, root.navigator && root.navigator.language);
    document.documentElement.lang = chosen;
    document.title = chosen === "fr" ? "Musée rétrogaming" : "Retrogaming museum";
  }
  var fr = document.documentElement.lang === "fr";
  var text = fr
    ? { title: "Musée rétrogaming", label: "Mot de passe", remember: "Se souvenir de moi sur cet appareil",
        submit: "Déverrouiller", wrong: "Mot de passe incorrect",
        unsupported: "Navigateur non pris en charge" }
    : { title: "Retrogaming museum", label: "Password", remember: "Remember me on this device",
        submit: "Unlock", wrong: "Wrong password", unsupported: "Browser not supported" };

  function show(html) {
    document.open();
    document.write(html);
    document.close();
  }

  function showForm() {
    var main = document.getElementById("unlock");
    var form = document.createElement("form");
    form.className = "unlock";
    var h1 = document.createElement("h1");
    h1.textContent = text.title;
    var label = document.createElement("label");
    label.textContent = text.label;
    var input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "current-password";
    input.required = true;
    label.appendChild(input);
    var rememberLabel = document.createElement("label");
    rememberLabel.className = "remember";
    var remember = document.createElement("input");
    remember.type = "checkbox";
    rememberLabel.appendChild(remember);
    rememberLabel.appendChild(document.createTextNode(text.remember));
    var button = document.createElement("button");
    button.type = "submit";
    button.textContent = text.submit;
    var error = document.createElement("p");
    error.className = "unlock-error";
    error.setAttribute("role", "alert");
    [h1, label, rememberLabel, button, error].forEach(function (n) { form.appendChild(n); });
    main.appendChild(form);
    input.focus();
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      error.textContent = "";
      button.disabled = true;
      button.textContent = "\u2026";
      if (!(root.crypto && root.crypto.subtle && root.TextEncoder)) {
        error.textContent = text.unsupported;
        button.disabled = false;
        button.textContent = text.submit;
        return;
      }
      Promise.resolve().then(function () {
        return deriveKeyBytes(input.value, payload);
      }).then(function (keyBytes) {
        return decryptWithKeyBytes(keyBytes, payload).then(function (html) {
          store(keyBytes, payload, remember.checked);
          show(html);
        });
      }).catch(function (failure) {
        // Only a failed decryption means a wrong password; anything else is a broken browser.
        var wrongPassword = failure && failure.name === "OperationError";
        error.textContent = wrongPassword ? text.wrong : text.unsupported;
        input.select();
        button.disabled = false;
        button.textContent = text.submit;
      });
    });
  }

  var stored = readStored();
  if (stored && stored.salt === payload.salt) {
    Promise.resolve().then(function () {
      return decryptWithKeyBytes(fromB64(stored.key), payload);
    }).then(show).catch(function () {
      forgetStored();
      showForm();
    });
  } else {
    if (stored) { forgetStored(); }
    showForm();
  }
})(typeof window !== "undefined" ? window : globalThis);
