(function() {
  // Prevent duplicate injections across extension updates
  if (window.__aiSelectionHelperLoaded_v3) return;
  window.__aiSelectionHelperLoaded_v3 = true;
  
  // Clean up any old panels from previous versions
  document.querySelectorAll("#ai-helper-root").forEach(el => el.remove());

  console.log("AI Selection Helper: Content script initialized.");

  // [Edge1 Fix] Maximum text length limit
  const MAX_TEXT_LENGTH = 8000;

  // Configuration Cache
  let config = {
    showFloatButton: true,
    theme: "auto",
    fontColor: "#000000",
    fontSize: "15",
    fontWeight: "400",
    enableSuperCopy: false
  };

  // State Variables
  let currentSelectionText = "";
  let answerPanel = null;
  let shadowRoot = null;
  let activePort = null;
  let isStreaming = false; // Track streaming state for disconnect detection
  let codeBlocksCache = []; // Store code blocks for copy-to-clipboard functionality

  // [Edge4 Fix] HTML escape helper to prevent XSS
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Initialize: Load settings and create UI elements
  function init() {
    chrome.storage.local.get({
      showFloatButton: true,
      theme: "auto",
      fontColor: "#000000",
      fontSize: "15",
      fontWeight: "400",
      fontOpacity: "100",
      customShortcut: "",
      enableSuperCopy: false
    }, (settings) => {
      config = settings;
      applyFontSettings();
      updateSuperCopyState();
    });

    // Listen for options changes
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.showFloatButton) config.showFloatButton = changes.showFloatButton.newValue;
      if (changes.theme) {
        config.theme = changes.theme.newValue;
        applyTheme();
      }
      if (changes.fontColor) {
        config.fontColor = changes.fontColor.newValue;
        applyFontSettings();
      }
      if (changes.fontSize) {
        config.fontSize = changes.fontSize.newValue;
        applyFontSettings();
      }
      if (changes.fontWeight) {
        config.fontWeight = changes.fontWeight.newValue;
        applyFontSettings();
      }
      if (changes.fontOpacity) {
        config.fontOpacity = changes.fontOpacity.newValue;
        applyFontSettings();
      }
      if (changes.customShortcut) {
        config.customShortcut = changes.customShortcut.newValue;
      }
      if (changes.enableSuperCopy) {
        config.enableSuperCopy = changes.enableSuperCopy.newValue;
        updateSuperCopyState();
      }
    });

    createUI();
    setupSelectionListeners();
  }

  // SuperCopy Bypass Logic
  const superCopyEvents = ['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart', 'keydown'];

  function handleSuperCopyCapture(e) {
    if (!config.enableSuperCopy) return;

    const type = e.type;
    if (type === 'keydown') {
      const isCopy = (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C');
      const isSelectAll = (e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A');
      const isCut = (e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X');
      if (isCopy || isSelectAll || isCut) {
        e.stopPropagation();
      }
    } else {
      e.stopPropagation();
    }
  }

  function updateSuperCopyState() {
    // 1. Manage CSS styles
    let styleEl = document.getElementById("ai-supercopy-style");
    if (config.enableSuperCopy) {
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = "ai-supercopy-style";
        styleEl.innerHTML = `
          * {
            user-select: text !important;
            -webkit-user-select: text !important;
            -moz-user-select: text !important;
            -ms-user-select: text !important;
          }
        `;
        document.documentElement.appendChild(styleEl);
      }
    } else {
      if (styleEl) styleEl.remove();
    }

    // 2. Manage capturing event listeners on window
    superCopyEvents.forEach(type => {
      window.removeEventListener(type, handleSuperCopyCapture, true);
    });

    if (config.enableSuperCopy) {
      superCopyEvents.forEach(type => {
        window.addEventListener(type, handleSuperCopyCapture, true);
      });
    }
  }

  // Inject UI Host & Shadow DOM
  function createUI() {
    let host = document.getElementById("ai-helper-root");
    if (host) {
      shadowRoot = host.shadowRoot;
      if (shadowRoot) {
        answerPanel = shadowRoot.querySelector(".ai-panel");
        return;
      }
    }

    host = document.createElement("div");
    host.id = "ai-helper-root";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none"; // Let clicks pass through unless on children
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: "open" });

    // Link stylesheet inside Shadow DOM
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("content.css");
    shadowRoot.appendChild(link);

    // Create wrapper element inside shadow DOM
    const wrapper = document.createElement("div");
    wrapper.id = "ai-helper-wrapper";
    wrapper.style.pointerEvents = "auto";
    shadowRoot.appendChild(wrapper);



    // Create Floating Panel element
    answerPanel = document.createElement("div");
    answerPanel.className = "ai-panel";
    answerPanel.style.display = "none";
    answerPanel.innerHTML = `
      <div class="ai-panel-header">
        <div class="ai-panel-title">
          <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
          <span>AI 解析助手</span>
        </div>
        <div class="ai-panel-actions">
          <button class="ai-panel-btn ai-panel-btn-min" title="折叠/展开">
            <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
          <button class="ai-panel-btn ai-panel-btn-close" title="关闭">
            <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>
      <div class="ai-panel-body">
        <div class="ai-panel-query"></div>
        <div class="ai-panel-answer"></div>
      </div>
      <div class="ai-panel-footer">
        <div class="ai-panel-status">
          <span class="ai-status-dot"></span>
          <span class="ai-status-text">就绪</span>
        </div>
        <div class="ai-panel-actions-bottom">
          <button class="ai-footer-btn ai-btn-copy" title="复制完整回答">
            <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            复制
          </button>
        </div>
      </div>
      <div class="ai-toast">已复制到剪贴板</div>
    `;
    wrapper.appendChild(answerPanel);

    // Setup UI interactivity
    setupPanelEvents();
  }

  // Setup Event Listeners for Selection (Menu/Shortcut only, no floating bubble)
  function setupSelectionListeners() {
    let lastTriggerTime = 0;
    
    // Helper to debounce and prevent overlapping triggers if local and background shortcuts fire simultaneously
    function handleAIShow(text, x, y) {
      const now = Date.now();
      if (now - lastTriggerTime < 500) {
        console.log("AI Selection Helper: Ignored duplicate trigger.");
        return;
      }
      lastTriggerTime = now;
      showPanel(text, x, y);
      triggerAI(text);
    }

    // Listen for messages from background script (Context menu trigger & keyboard shortcut)
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === "TRIGGER_AI_FROM_MENU") {
        const selection = window.getSelection();
        let x = window.innerWidth / 2 - 200;
        let y = window.innerHeight / 2 - 200;

        if (selection.rangeCount > 0) {
          const rect = selection.getRangeAt(0).getBoundingClientRect();
          x = rect.left;
          y = rect.bottom + 10;
        }

        handleAIShow(msg.text, x, y);
        sendResponse({ success: true });
        return true;
      }

      // [Flow3 Fix] Handle keyboard shortcut trigger
      if (msg.action === "TRIGGER_AI_FROM_SHORTCUT") {
        const selection = window.getSelection();
        const selectedText = selection.toString().trim();
        if (selectedText.length > 0) {
          let x = window.innerWidth / 2 - 200;
          let y = window.innerHeight / 2 - 200;
          if (selection.rangeCount > 0) {
            const rect = selection.getRangeAt(0).getBoundingClientRect();
            x = rect.left;
            y = rect.bottom + 10;
          }
          handleAIShow(selectedText, x, y);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, reason: "no_selection" });
        }
        return true;
      }
    });

    // Listen for custom webpage shortcut keydown
    function keydownHandler(e) {
      if (e.repeat) return; // Prevent repeated triggers on key-holding

      // Clean up listener if context was invalidated (extension reloaded/updated)
      if (!chrome.runtime || !chrome.runtime.id) {
        window.removeEventListener("keydown", keydownHandler, true);
        return;
      }

      if (!config.customShortcut) return;

      // Skip if focused on input elements to avoid capturing regular typing
      const activeEl = document.activeElement;
      if (activeEl && (
        activeEl.tagName === "INPUT" || 
        activeEl.tagName === "TEXTAREA" || 
        activeEl.isContentEditable
      )) {
        return;
      }

      const pressed = getShortcutString(e);
      if (pressed === config.customShortcut) {
        const selection = window.getSelection();
        const selectedText = selection.toString().trim();
        if (selectedText.length > 0) {
          e.preventDefault();
          e.stopPropagation();

          let x = window.innerWidth / 2 - 200;
          let y = window.innerHeight / 2 - 200;
          if (selection.rangeCount > 0) {
            const rect = selection.getRangeAt(0).getBoundingClientRect();
            x = rect.left;
            y = rect.bottom + 10;
          }

          handleAIShow(selectedText, x, y);
        }
      }
    }

    window.addEventListener("keydown", keydownHandler, true);
  }

  // Parse key event to formatted string matching saved customShortcut representation
  function getShortcutString(e) {
    const modifiers = [];
    if (e.ctrlKey) modifiers.push("Ctrl");
    if (e.altKey) modifiers.push("Alt");
    if (e.shiftKey) modifiers.push("Shift");
    if (e.metaKey) modifiers.push("Meta");

    const key = e.key;
    if (key !== "Control" && key !== "Alt" && key !== "Shift" && key !== "Meta") {
      let displayKey = key;
      if (key.length === 1) {
        displayKey = key.toUpperCase();
      }
      modifiers.push(displayKey);
      return modifiers.join("+");
    }
    return "";
  }

  // Draggable and Interactive Panel actions
  function setupPanelEvents() {
    const header = shadowRoot.querySelector(".ai-panel-header");
    const closeBtn = shadowRoot.querySelector(".ai-panel-btn-close");
    const minBtn = shadowRoot.querySelector(".ai-panel-btn-min");
    const copyBtn = shadowRoot.querySelector(".ai-btn-copy");

    // Drag panel implementation
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let panelStartX = 0;
    let panelStartY = 0;

    header.addEventListener("mousedown", (e) => {
      // Ignore if clicking sub-buttons
      if (e.target.closest(".ai-panel-btn")) return;

      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;

      const rect = answerPanel.getBoundingClientRect();
      panelStartX = rect.left;
      panelStartY = rect.top;

      header.style.cursor = "grabbing";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;

      let newLeft = panelStartX + dx;
      let newTop = panelStartY + dy;

      // Restrict within viewport boundaries
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const panelW = answerPanel.offsetWidth;
      const panelH = answerPanel.offsetHeight;

      if (newLeft < 10) newLeft = 10;
      if (newLeft + panelW > viewportW - 10) newLeft = viewportW - panelW - 10;
      if (newTop < 10) newTop = 10;
      if (newTop + panelH > viewportH - 10) newTop = viewportH - panelH - 10;

      answerPanel.style.left = `${newLeft}px`;
      answerPanel.style.top = `${newTop}px`;
      // Remove right alignment style if set initially
      answerPanel.style.right = "auto";
    }

    function onMouseUp() {
      isDragging = false;
      header.style.cursor = "move";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }

    // Collapse / Minimize
    minBtn.addEventListener("click", () => {
      answerPanel.classList.toggle("minimized");
    });

    // Close Panel
    closeBtn.addEventListener("click", () => {
      closePanel();
    });

    // Copy Answer
    copyBtn.addEventListener("click", () => {
      const answerElement = shadowRoot.querySelector(".ai-panel-answer");
      // Use clean innerText to copy text formatting
      navigator.clipboard.writeText(answerElement.innerText).then(() => {
        showToast("回答已复制！");
      }).catch(err => {
        console.error("Failed to copy text:", err);
      });
    });

    // Code copy event delegation
    answerPanel.addEventListener("click", (e) => {
      const copyBtn = e.target.closest(".code-copy-btn");
      if (copyBtn) {
        const index = parseInt(copyBtn.getAttribute("data-index"), 10);
        // [Edge6 Fix] Handle race condition - check for undefined during streaming
        if (!isNaN(index) && codeBlocksCache[index] !== undefined) {
          navigator.clipboard.writeText(codeBlocksCache[index]).then(() => {
            const originalText = copyBtn.innerHTML;
            copyBtn.innerHTML = `
              <svg viewBox="0 0 24 24" width="12" height="12" stroke="#10b981" stroke-width="2" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>
              已复制
            `;
            setTimeout(() => {
              copyBtn.innerHTML = originalText;
            }, 1500);
          }).catch(err => console.error("Failed to copy code block:", err));
        }
      }
    });

    // Close panel when user clicks anywhere outside of it
    // Use capture phase on window to bypass websites that call stopPropagation() on mousedown
    window.addEventListener("mousedown", (e) => {
      const path = e.composedPath();
      if (!path.some(node => node.id === "ai-helper-root")) {
        closePanel();
      }
    }, true);
  }

  // Show Panel
  function showPanel(queryText, x, y) {
    applyTheme();
    applyFontSettings();
    codeBlocksCache = []; // Reset code cache

    const queryBox = shadowRoot.querySelector(".ai-panel-query");
    const answerBox = shadowRoot.querySelector(".ai-panel-answer");

    // Clean previous output
    queryBox.innerText = `选中内容: "${queryText}"`;
    answerBox.innerHTML = `
      <div class="ai-loading-container">
        <span>AI 正在思考中...</span>
      </div>
    `;

    updateStatus("loading", "发送请求...");

    // Position panel near the selection/bubble
    const panelWidth = 400;
    const panelHeight = 350; // approximate default height

    let left = x;
    let top = y;

    // Viewport check
    if (left + panelWidth > window.innerWidth) {
      left = window.innerWidth - panelWidth - 20;
    }
    if (left < 10) left = 10;

    if (top + panelHeight > window.innerHeight) {
      top = y - panelHeight - 30; // position above selection if it overflows below
    }
    if (top < 10) top = 10;

    answerPanel.style.left = `${left}px`;
    answerPanel.style.top = `${top}px`;
    answerPanel.style.right = "auto";
    answerPanel.classList.remove("minimized");
    answerPanel.style.display = "flex";
  }

  // Close Panel
  function closePanel() {
    answerPanel.style.display = "none";
    isStreaming = false;
    // Disconnect port if still streaming
    if (activePort) {
      activePort.disconnect();
      activePort = null;
      console.log("AI Selection Helper: Active request stream cancelled.");
    }
    // Reset status to prevent stale "生成中..." from leaking
    updateStatus("idle", "就绪");
  }

  // Apply visual theme settings
  function applyTheme() {
    const isDark = config.theme === "dark" || 
      (config.theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    
    if (isDark) {
      answerPanel.classList.add("theme-dark");
    } else {
      answerPanel.classList.remove("theme-dark");
    }
  }

  // Apply dynamic font styles to the answer container
  function applyFontSettings() {
    if (!shadowRoot) return;
    
    let styleTag = shadowRoot.getElementById("ai-dynamic-font");
    if (!styleTag) {
      styleTag = document.createElement("style");
      styleTag.id = "ai-dynamic-font";
      shadowRoot.appendChild(styleTag);
    }
    
    const color = config.fontColor || "#000000";
    const size = config.fontSize || "15";
    const weight = config.fontWeight || "400";
    const opacityVal = parseFloat(config.fontOpacity || "100") / 100;
    
    // Inject dynamic CSS to forcefully override all font settings inside the answer panel and loading texts
    styleTag.textContent = `
      .ai-panel-answer {
        opacity: ${opacityVal} !important;
      }
      .ai-panel-answer,
      .ai-panel-answer span,
      .ai-panel-answer p,
      .ai-panel-answer div,
      .ai-thinking-content,
      .ai-loading-container,
      .ai-loading-container span {
        color: ${color} !important;
        font-size: ${size}px !important;
        font-weight: ${weight} !important;
        line-height: 1.6 !important;
      }
      .ai-panel-answer pre code,
      .ai-panel-answer code {
        font-family: Consolas, Monaco, "Andale Mono", monospace !important;
      }
    `;
  }

  // Update footer status
  function updateStatus(state, text) {
    const dot = shadowRoot.querySelector(".ai-status-dot");
    const txt = shadowRoot.querySelector(".ai-status-text");

    dot.className = "ai-status-dot";
    dot.classList.add(state);
    txt.innerText = text;
  }

  // Show visual toast notification inside shadow DOM
  function showToast(text) {
    const toast = shadowRoot.querySelector(".ai-toast");
    toast.innerText = text;
    toast.classList.add("show");
    setTimeout(() => {
      toast.classList.remove("show");
    }, 2000);
  }

  // Connect to background script and trigger AI streaming
  function triggerAI(text) {
    // If there is an active stream, cancel it first
    if (activePort) {
      activePort.disconnect();
    }

    // [Edge1 Fix] Character limit check
    let truncated = false;
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.substring(0, MAX_TEXT_LENGTH);
      truncated = true;
    }

    // Update queryBox to show the actual text being sent (truncated if needed)
    const queryBox = shadowRoot.querySelector(".ai-panel-query");
    queryBox.innerText = `选中内容: "${text}"${truncated ? " (已截断至 8000 字)" : ""}`;
    if (truncated) {
      showToast(`文本过长，已截断至前 ${MAX_TEXT_LENGTH} 字符`);
    }

    let fullAnswer = "";
    let fullThinking = "";
    const answerBox = shadowRoot.querySelector(".ai-panel-answer");

    // Establish connection to service worker
    activePort = chrome.runtime.connect({ name: "ai-stream" });
    isStreaming = true;

    activePort.postMessage({
      action: "REQUEST_AI",
      text: text
    });

    activePort.onMessage.addListener((msg) => {
      if (msg.action === "think") {
        if (fullThinking === "") {
          updateStatus("loading", "正在思考...");
        }
        fullThinking += msg.text;
        renderResponse("", answerBox, fullThinking, true);
        
        // Auto-scroll body to follow stream text
        const body = shadowRoot.querySelector(".ai-panel-body");
        body.scrollTop = body.scrollHeight;
      }
      else if (msg.action === "chunk") {
        if (fullAnswer === "") {
          // Remove loading spinner on first chunk
          answerBox.innerHTML = "";
          updateStatus("loading", "生成中...");
        }
        fullAnswer += msg.text;
        renderResponse(fullAnswer, answerBox, fullThinking, false);
        
        // Auto-scroll body to follow stream text
        const body = shadowRoot.querySelector(".ai-panel-body");
        body.scrollTop = body.scrollHeight;
      } 
      else if (msg.action === "done") {
        isStreaming = false;
        renderResponse(fullAnswer, answerBox, fullThinking, false);
        updateStatus("active", "已完成");
        activePort.disconnect();
        activePort = null;
      } 
      else if (msg.action === "error") {
        isStreaming = false;
        // [Edge4 Fix] Escape error message HTML to prevent XSS
        answerBox.innerHTML = `
          <div class="ai-error-box">
            <strong>请求失败:</strong> ${escapeHtml(msg.error)}
            <button class="ai-retry-btn" style="margin-top:8px;background:var(--primary-color);color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">重试</button>
          </div>
        `;
        answerBox.querySelector(".ai-retry-btn").addEventListener("click", () => {
          triggerAI(text);
        });
        updateStatus("error", "出错");
        activePort.disconnect();
        activePort = null;
      }
    });

    // [Edge3 Fix] Handle unexpected port disconnection (e.g., Service Worker killed)
    activePort.onDisconnect.addListener(() => {
      if (activePort && isStreaming) {
        // Unexpected disconnect while streaming - update UI
        updateStatus("error", "连接中断");
        answerBox.innerHTML = `
          <div class="ai-error-box">
            <strong>请求失败:</strong> 连接中断（Service Worker 可能已休眠或异常）
            <button class="ai-retry-btn" style="margin-top:8px;background:var(--primary-color);color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">重试</button>
          </div>
        `;
        answerBox.querySelector(".ai-retry-btn").addEventListener("click", () => {
          triggerAI(text);
        });
        isStreaming = false;
      }
      activePort = null;
    });
  }

  // Render text content and parse Markdown
  function renderResponse(md, targetElement, thinkingText = "", showLoader = false) {
    codeBlocksCache = []; // Clear for this parse pass
    let html = "";
    
    if (thinkingText) {
      const escapedThinking = escapeHtml(thinkingText);
      html += `
        <details class="ai-thinking-details" open>
          <summary>AI 思考过程</summary>
          <div class="ai-thinking-content">${escapedThinking}</div>
        </details>
      `;
    }
    
    if (md) {
      html += parseMarkdown(md);
    }
    
    if (showLoader) {
      html += `
        <div class="ai-loading-container">
          <span>AI 正在分析中...</span>
        </div>
      `;
    }
    
    targetElement.innerHTML = html;
    applyFontSettings();
  }

  // Robust Markdown-to-HTML parser
  function parseMarkdown(md) {
    if (!md) return "";

    // Escape HTML tags to prevent execution
    let html = md
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // 1. Code block extractor: ```[lang]\n[code]\n```
    const backtickCount = (html.match(/```/g) || []).length;
    if (backtickCount % 2 !== 0) {
      html += "\n```";
    }

    html = html.replace(/```(\w*)\n([\s\S]*?)\n```/g, (match, lang, code) => {
      const cleanCode = code.trim();
      const index = codeBlocksCache.length;
      codeBlocksCache.push(cleanCode); // Save raw code for copy action
      
      const placeholder = `<!--CODE_BLOCK_${index}-->`;
      return placeholder;
    });

    // 2. Inline code: `code`
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // 3. Bold: **text** or __text__
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");

    // 4. Headings: #, ##, ###, ####
    html = html.replace(/^#### (.*)$/gm, "<h4>$1</h4>");
    html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.*)$/gm, "<h3>$1</h3>");
    html = html.replace(/^# (.*)$/gm, "<h3>$1</h3>");

    // [Edge5 Fix] 4.5. Blockquotes: > text (already escaped as &gt;)
    html = html.replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");
    // Merge consecutive blockquotes
    html = html.replace(/<\/blockquote>\n<blockquote>/g, "\n");

    // 5. Bullet lists (- or * or +)
    let inList = false;
    const lines = html.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("+ ")) {
        const content = line.substring(2);
        if (!inList) {
          lines[i] = "<ul><li>" + content + "</li>";
          inList = true;
        } else {
          lines[i] = "<li>" + content + "</li>";
        }
      } else {
        if (inList) {
          lines[i - 1] += "</ul>";
          inList = false;
        }
      }
    }
    if (inList) {
      lines[lines.length - 1] += "</ul>";
    }
    html = lines.join("\n");

    // 6. Numbered lists (1. 2.)
    let inOList = false;
    const linesO = html.split("\n");
    for (let i = 0; i < linesO.length; i++) {
      const line = linesO[i].trim();
      const match = line.match(/^(\d+)\.\s+(.*)$/);
      if (match) {
        const content = match[2];
        if (!inOList) {
          linesO[i] = "<ol><li>" + content + "</li>";
          inOList = true;
        } else {
          linesO[i] = "<li>" + content + "</li>";
        }
      } else {
        if (inOList) {
          linesO[i - 1] += "</ol>";
          inOList = false;
        }
      }
    }
    if (inOList) {
      linesO[linesO.length - 1] += "</ol>";
    }
    html = linesO.join("\n");

    // 7. Paragraph blocks split by multiple newlines
    const blocks = html.split(/\n\n+/);
    for (let i = 0; i < blocks.length; i++) {
      let block = blocks[i].trim();
      if (!block) continue;

      if (block.startsWith("<h") || block.startsWith("<ul") || block.startsWith("<ol") || block.startsWith("<!--CODE_BLOCK_") || block.startsWith("<blockquote")) {
        // structural block, don't wrap
      } else {
        block = "<p>" + block.replace(/\n/g, "<br>") + "</p>";
      }
      blocks[i] = block;
    }
    html = blocks.join("\n");

    // 8. Restore Code Blocks
    for (let i = 0; i < codeBlocksCache.length; i++) {
      const code = codeBlocksCache[i];
      const placeholder = `<!--CODE_BLOCK_${i}-->`;
      const codeBlockHtml = `
        <div class="code-block-header">
          <span>代码片段</span>
          <button class="code-copy-btn" data-index="${i}">
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            复制
          </button>
        </div>
        <pre class="pre-with-header"><code>${code}</code></pre>
      `;
      html = html.replace(placeholder, codeBlockHtml);
    }

    return html;
  }

  // Execute initialization
  init();
})();
