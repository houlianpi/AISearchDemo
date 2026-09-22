import { buildMessageRequest, createSessionId, RequestLifecycle, validateImageFile } from "/assets/client-logic.js";

(function () {
  "use strict";
  var sessionId = createSessionId();
  var selectedImage = null;
  var displayedQueryImageUrl = null;
  var lastRequest = null;
  var requests = new RequestLifecycle();

  var form = document.getElementById("search-form");
  var prompt = document.getElementById("prompt");
  var imageInput = document.getElementById("image-input");
  var imagePreview = document.getElementById("image-preview");
  var previewImage = document.getElementById("preview-image");
  var previewName = document.getElementById("preview-name");
  var removeImage = document.getElementById("remove-image");
  var submitButton = document.getElementById("submit-button");
  var newSessionButton = document.getElementById("new-session");
  var appShell = document.querySelector(".app-shell");
  var emptyState = document.getElementById("empty-state");
  var conversation = document.getElementById("conversation");
  var queryBubble = document.getElementById("query-bubble");
  var answer = document.getElementById("answer");
  var sourcesSection = document.getElementById("sources-section");
  var sources = document.getElementById("sources");
  var loading = document.getElementById("loading");
  var errorBox = document.getElementById("error");
  var busy = false;

  prompt.addEventListener("input", updateSubmitButton);

  imageInput.addEventListener("change", function () {
    var file = imageInput.files && imageInput.files[0];
    if (!file) return;
    try { validateImageFile(file); } catch (error) { showError(error.message); imageInput.value = ""; return; }
    selectedImage = file;
    previewImage.src = URL.createObjectURL(file);
    previewName.textContent = file.name;
    imagePreview.hidden = false;
    clearError();
  });

  removeImage.addEventListener("click", clearImage);
  newSessionButton.addEventListener("click", resetSession);
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    submit(prompt.value.trim(), selectedImage).catch(function (error) {
      if (error && error.name === "AbortError") return;
      showError(error.message || "The request failed. Please try again.");
    });
  });

  async function submit(text, file) {
    if (!text) { showError("Enter a question before searching."); prompt.focus(); return; }
    var activeRequest = requests.start();
    var requestSessionId = sessionId;
    setBusy(true);
    clearError();
    showPendingQuestion(text, file);
    if (file) clearImage();
    try {
      var image = file ? await fileToImage(file) : null;
      if (!requests.isCurrent(activeRequest)) return;
      var request = buildMessageRequest(text, image);
      lastRequest = request;
      var response = await fetch("/v1/sessions/" + encodeURIComponent(requestSessionId) + "/messages", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: activeRequest.controller.signal
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!requests.isCurrent(activeRequest)) return;
      if (!response.ok) throw new Error(payload.error && payload.error.message || "The search request failed.");
      renderResponse(payload);
      prompt.value = "";
      prompt.placeholder = "Ask a follow up";
      clearImage();
    } finally {
      if (requests.isCurrent(activeRequest)) { requests.finish(activeRequest); setBusy(false); }
    }
  }

  function renderResponse(payload) {
    conversation.hidden = false;
    renderAnswer(answer, payload.answer || "No answer was returned.");
    sources.replaceChildren();
    var results = Array.isArray(payload.searchResults) ? payload.searchResults.slice(0, 3) : [];
    results.forEach(function (result) { sources.appendChild(createSourceCard(result)); });
    sourcesSection.hidden = results.length === 0;
  }

  function showPendingQuestion(question, file) {
    appShell.classList.add("has-session");
    emptyState.hidden = true;
    conversation.hidden = false;
    renderQueryBubble(question, file);
    answer.replaceChildren();
    sources.replaceChildren();
    sourcesSection.hidden = true;
    prompt.value = "";
  }

  function renderQueryBubble(question, file) {
    if (displayedQueryImageUrl) URL.revokeObjectURL(displayedQueryImageUrl);
    displayedQueryImageUrl = null;
    queryBubble.replaceChildren();
    if (file) {
      displayedQueryImageUrl = URL.createObjectURL(file);
      var image = element("img", "query-image");
      image.src = displayedQueryImageUrl;
      image.alt = "Attached image";
      queryBubble.appendChild(image);
    }
    var text = element("span", "query-text");
    text.textContent = question;
    queryBubble.appendChild(text);
  }

  function createSourceCard(result) {
    var card = element("a", "source-card");
    card.href = safeHttpUrl(result.url) || "#";
    card.target = "_blank"; card.rel = "noopener noreferrer";
    var body = element("div");
    var header = element("div", "source-header");
    if (safeHttpUrl(result.faviconUrl)) {
      var icon = element("img", "favicon"); icon.src = result.faviconUrl; icon.alt = ""; header.appendChild(icon);
    } else {
      var fallback = element("span", "favicon-fallback"); fallback.textContent = String(result.sourceName || result.source || "S").charAt(0).toUpperCase(); header.appendChild(fallback);
    }
    var name = element("span", "source-name"); name.textContent = result.sourceName || result.source || "Source"; header.appendChild(name); body.appendChild(header);
    var title = element("div", "source-title"); title.textContent = result.title || result.url; body.appendChild(title);
    var metaParts = [result.publishedAt, result.author].filter(Boolean);
    if (metaParts.length) { var meta = element("div", "source-meta"); meta.textContent = metaParts.join(" · "); body.appendChild(meta); }
    if (result.snippet) { var snippet = element("div", "source-snippet"); snippet.textContent = result.snippet; body.appendChild(snippet); }
    card.appendChild(body);
    if (safeHttpUrl(result.thumbnailUrl)) {
      var wrap = element("div", "thumbnail-wrap"); var image = element("img", "thumbnail"); image.src = result.thumbnailUrl; image.alt = ""; wrap.appendChild(image);
      if (result.duration) { var duration = element("span", "duration"); duration.textContent = result.duration; wrap.appendChild(duration); }
      card.appendChild(wrap);
    } else card.classList.add("no-image");
    return card;
  }

  function renderAnswer(container, markdown) {
    container.replaceChildren();
    var lines = String(markdown).split(/\r?\n/);
    var list = null;
    lines.forEach(function (line) {
      if (!line.trim()) { list = null; return; }
      var bullet = /^[-*]\s+(.+)$/.exec(line);
      if (bullet) {
        if (!list) { list = element("ul", "answer-list"); container.appendChild(list); }
        var item = element("li"); appendInlineMarkdown(item, bullet[1]); list.appendChild(item); return;
      }
      list = null;
      var heading = /^(#{1,3})\s+(.+)$/.exec(line);
      var block = element(heading ? "h3" : "p", heading ? "answer-subheading" : "answer-paragraph");
      appendInlineMarkdown(block, heading ? heading[2] : line);
      container.appendChild(block);
    });
  }

  function appendInlineMarkdown(container, text) {
    var pattern = /(\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)]+)\))/g;
    var cursor = 0; var match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > cursor) container.appendChild(document.createTextNode(text.slice(cursor, match.index)));
      if (match[2]) { var strong = element("strong"); strong.textContent = match[2]; container.appendChild(strong); }
      else { var link = element("a"); link.textContent = match[3]; link.href = match[4]; link.target = "_blank"; link.rel = "noopener noreferrer"; container.appendChild(link); }
      cursor = pattern.lastIndex;
    }
    if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function fileToImage(file) {
    validateImageFile(file);
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("The selected image could not be read.")); };
      reader.onload = function () {
        var dataUrl = String(reader.result || "");
        var comma = dataUrl.indexOf(",");
        if (comma < 0) reject(new Error("The selected image could not be encoded."));
        else resolve({ mimeType: file.type, data: dataUrl.slice(comma + 1) });
      };
      reader.readAsDataURL(file);
    });
  }
  function clearImage() {
    if (previewImage.src && previewImage.src.startsWith("blob:")) URL.revokeObjectURL(previewImage.src);
    selectedImage = null; imageInput.value = ""; previewImage.removeAttribute("src"); imagePreview.hidden = true;
  }
  function resetSession() {
    requests.cancel();
    sessionId = createSessionId();
    lastRequest = null;
    setBusy(false);
    clearImage();
    prompt.value = "";
    prompt.placeholder = "Ask anything";
    appShell.classList.remove("has-session");
    emptyState.hidden = false;
    conversation.hidden = true;
    queryBubble.textContent = "";
    if (displayedQueryImageUrl) URL.revokeObjectURL(displayedQueryImageUrl);
    displayedQueryImageUrl = null;
    answer.replaceChildren();
    sources.replaceChildren();
    sourcesSection.hidden = true;
    clearError();
    updateSubmitButton();
    prompt.focus();
  }
  function setBusy(isBusy) {
    busy = isBusy;
    submitButton.disabled = isBusy; imageInput.disabled = isBusy; prompt.disabled = isBusy; loading.hidden = !isBusy;
    updateSubmitButton();
  }
  function updateSubmitButton() {
    submitButton.hidden = !busy && !prompt.value.trim();
    submitButton.setAttribute("aria-label", busy ? "Searching" : "Submit question");
  }
  function showError(message) { errorBox.textContent = message; errorBox.hidden = false; }
  function clearError() { errorBox.textContent = ""; errorBox.hidden = true; }
  function element(tag, className) { var node = document.createElement(tag); if (className) node.className = className; return node; }
  function safeHttpUrl(value) { try { var url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.href : null; } catch (_) { return null; } }
  window.__AI_SEARCH_DEMO__ = { getSessionId: function () { return sessionId; }, getLastRequest: function () { return lastRequest; } };
  updateSubmitButton();
})();
