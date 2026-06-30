// Default Configuration
const DEFAULTS = {
  provider: "openai",
  apiKey: "",
  endpoint: "https://api.siliconflow.cn/v1",
  model: "deepseek-ai/DeepSeek-V4-Flash",
  systemPrompt: "你是一个最极简的答题机器。不要解析，不要原理，只给最终答案：\n1. 选择题/多选题：只输出正确选项字母（如：A），不要任何其他文字。\n2. 判断题：只输出【对】或【错】，不要解析。\n3. 其他题目：仅用一句话回答核心答案，字数控制在 50 字以内。",
  showFloatButton: false,
  theme: "auto",
  currentPreset: "siliconflow-deepseek",
  enableThinking: false,
  fontColor: "#000000",
  fontSize: "15",
  fontWeight: "400",
  fontOpacity: "100",
  customShortcutAI: "Alt+Z",
  customShortcutLocal: "Alt+Q",
  enableSuperCopy: false
};

// [Bug1 Fix] Only initialize defaults on first install, not on update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.local.set(DEFAULTS, () => {
      console.log("AI Selection Helper: Storage initialized with default settings.");
    });
  } else if (details.reason === "update") {
    // Migrate systemPrompt and presets if they were using the old default prompts, and force disable floating bubble
    const oldPrompt1 = "你是一个智能学习助手。请分析用户发送的题目或文本，给出最准确的答案和简洁的解析。如果是选择题，请直接给出正确选项和解析。";
    const oldPrompt2 = "你是一个极简答题助手。请遵循以下规则作答，不要有任何废话或原理说明：\n1. 选择题/多选题/判断题：只给出正确选项（如 A 或 BCD）或对错结果，绝对不要输出任何解析或额外字符。\n2. 简答题等其他题型：用最简洁的语言一句话回答完毕，绝对不分段，且总字数严格控制在 100 字以内。";
    chrome.storage.local.get({ systemPrompt: "", presets: {} }, (res) => {
      const updates = { showFloatButton: false };
      if (res.systemPrompt === oldPrompt1 || res.systemPrompt === oldPrompt2) {
        updates.systemPrompt = DEFAULTS.systemPrompt;
      }
      let presetsUpdated = false;
      const presets = res.presets;
      for (const preset of Object.values(presets)) {
        if (preset.systemPrompt === oldPrompt1 || preset.systemPrompt === oldPrompt2) {
          preset.systemPrompt = DEFAULTS.systemPrompt;
          presetsUpdated = true;
        }
      }
      if (presetsUpdated) {
        updates.presets = presets;
      }
      chrome.storage.local.set(updates, () => {
        console.log("AI Selection Helper: Upgraded configurations, set showFloatButton to false.");
      });
    });
  }

  // Context menu is safe to recreate on every install/update
  chrome.contextMenus.create({
    id: "ask-ai-selection",
    title: "使用 AI 解析选中文本",
    contexts: ["selection"]
  });
  console.log("AI Selection Helper: Context menu created.");
});

// Listen for context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "ask-ai-selection" && tab && tab.id) {
    // Check if the tab URL is supported (avoid chrome:// or other restricted schemes)
    if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("https://chromewebstore.google.com")) {
      console.warn("AI Selection Helper: Cannot run script on restricted page.");
      return;
    }
    
    // Send message to content script to trigger AI display
    chrome.tabs.sendMessage(tab.id, {
      action: "TRIGGER_AI_FROM_MENU",
      text: info.selectionText
    }).catch(err => {
      // Content script might not be loaded yet, try to inject first (fallback)
      console.log("Content script not ready, injecting...", err);
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      }).then(() => {
        return chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["content.css"]
        });
      }).then(() => {
        // Retry sending the message
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, {
            action: "TRIGGER_AI_FROM_MENU",
            text: info.selectionText
          }).catch(e => console.error("Failed to trigger after injection:", e));
        }, 300);
      }).catch(e => console.error("Injection failed:", e));
    });
  }
});

// [Flow3 Fix] Handle keyboard shortcut command
chrome.commands.onCommand.addListener((command) => {
  if (command === "trigger-ai" || command === "trigger-local-search") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: command === "trigger-ai" ? "TRIGGER_AI_FROM_SHORTCUT" : "TRIGGER_LOCAL_SEARCH_FROM_SHORTCUT"
        }).catch(err => {
          console.log("Content script not ready for shortcut:", err);
        });
      }
    });
    return;
  }

  if (command === "toggle-auto-answer" || command === "stop-auto-answer") {
    const action = command === "toggle-auto-answer" ? "START_AUTO_ANSWER" : "STOP_AUTO_ANSWER";
    sendAutoAnswerCommand(action);
  }
});

async function sendAutoAnswerCommand(action) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url || /^(chrome|edge|about):/i.test(tab.url)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action });
  } catch (err) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js", "auto-answer.js"] });
      await chrome.tabs.sendMessage(tab.id, { action });
    } catch (injectErr) {
      console.warn("AI Auto Answer: failed to inject/start", injectErr);
    }
  }
}

// Handle incoming connections from Content Script
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "ai-stream" || port.name === "ai-auto-answer") {
    port.onMessage.addListener(async (msg) => {
      if (msg.action === "REQUEST_AI") {
        try {
          await handleStreamRequest(msg.text, port);
        } catch (err) {
          try {
            port.postMessage({ action: "error", error: err.message });
          } catch (_) {
            // Port already disconnected, ignore
          }
        }
      }
    });
  }
});

// Listen for messages from Options page
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "TEST_API_CONNECTION") {
    performConnectionTest(request.settings)
      .then(reply => sendResponse({ success: true, reply }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }

  if (request.action === "FETCH_API_MODELS") {
    fetchModelsFromApi(request.settings)
      .then(models => sendResponse({ success: true, models }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }
});

// Helper: build Anthropic URL correctly, handling both /v1 and bare endpoints
function buildAnthropicUrl(endpoint, path) {
  let url = (endpoint || "https://api.anthropic.com").replace(/\/+$/, "");
  if (url.endsWith("/v1")) {
    url += "/" + path;
  } else if (!url.endsWith("/v1/" + path)) {
    url += "/v1/" + path;
  }
  return url;
}

// Helper: build OpenAI-compatible URL
function buildOpenAIUrl(endpoint, path) {
  let url = (endpoint || "https://api.openai.com/v1").replace(/\/+$/, "");
  if (!url.endsWith("/" + path)) {
    url += "/" + path;
  }
  return url;
}

// Stream Request Handler
async function handleStreamRequest(text, port) {
  // Get latest settings
  const settings = await new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (res) => {
      resolve(res);
    });
  });

  const provider = settings.provider || "mock";
  const apiKey = settings.apiKey;
  const systemPrompt = settings.systemPrompt || DEFAULTS.systemPrompt;

  if (provider === "mock") {
    await handleMockStream(text, port);
    return;
  }

  if (!apiKey) {
    throw new Error("请先点击插件图标并进入设置，配置您的 API Key。");
  }

  // Resolve API parameters based on provider
  let url = "";
  let modelName = settings.model;
  let headers = {
    "Content-Type": "application/json"
  };

  switch (provider) {
    case "gemini":
      modelName = modelName || "gemini-2.5-flash";
      // [Bug7 Fix] Only use Bearer token, don't expose key in URL
      url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "anthropic":
      modelName = modelName || "claude-3-5-sonnet-latest";
      // [Bug2 Fix] Use helper to correctly build URL
      url = buildAnthropicUrl(settings.endpoint, "messages");
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "openai":
    default:
      modelName = modelName || "gpt-4o-mini";
      url = buildOpenAIUrl(settings.endpoint, "chat/completions");
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
  }

  let requestBody;

  if (provider === "anthropic") {
    requestBody = {
      model: modelName,
      messages: [
        { role: "user", content: text }
      ],
      system: systemPrompt,
      max_tokens: 2048,
      stream: true
    };
  } else {
    requestBody = {
      model: modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ],
      stream: true
    };

    // If using OpenAI protocol but model/endpoint indicates DeepSeek, control thinking toggle
    if (modelName.toLowerCase().includes("deepseek") || url.toLowerCase().includes("deepseek")) {
      requestBody.thinking = {
        type: settings.enableThinking ? "enabled" : "disabled"
      };
    }
  }

  console.log(`AI Selection Helper: Sending request to ${provider} (${modelName}). URL: ${url}`);

  // [Edge2 Fix] Add AbortController with 30s timeout for initial connection
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("请求超时（30秒无响应），请检查网络连接和 API 地址是否正确。");
    }
    throw err;
  }

  if (!response.ok) {
    let errMsg = `HTTP error! status: ${response.status}`;
    try {
      const errorJson = await response.json();
      errMsg = errorJson.error?.message || errorJson.message || errMsg;
    } catch (_) {
      try {
        const errorText = await response.text();
        errMsg = errorText || errMsg;
      } catch (_) {}
    }
    throw new Error(`${provider.toUpperCase()} API 错误: ${errMsg}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    
    // Parse SSE format
    const lines = buffer.split("\n");
    // Save the last incomplete line back to the buffer
    buffer = lines.pop() || "";

    for (const line of lines) {
      const cleanedLine = line.trim();
      if (!cleanedLine) continue;

      if (cleanedLine.startsWith("data: ")) {
        const dataStr = cleanedLine.substring(6).trim();
        if (dataStr === "[DONE]") {
          try { port.postMessage({ action: "done" }); } catch (_) {}
          return;
        }

        try {
          const parsed = JSON.parse(dataStr);
          
          // OpenAI / Gemini / DeepSeek format
          let chunkContent = parsed.choices?.[0]?.delta?.content || "";
          let chunkReasoning = parsed.choices?.[0]?.delta?.reasoning_content || "";
          
          // Anthropic format
          if (!chunkContent && parsed.type === "content_block_delta" && parsed.delta?.text) {
            chunkContent = parsed.delta.text;
          }
          
          if (chunkReasoning) {
            try { port.postMessage({ action: "think", text: chunkReasoning }); } catch (_) { return; }
          }
          if (chunkContent) {
            try { port.postMessage({ action: "chunk", text: chunkContent }); } catch (_) { return; }
          }

          // Anthropic stop event
          if (parsed.type === "message_stop") {
            try { port.postMessage({ action: "done" }); } catch (_) {}
            return;
          }
        } catch (err) {
          console.warn("Failed to parse SSE line JSON:", dataStr, err);
        }
      }
    }
  }

  // Handle any remaining buffer data
  if (buffer) {
    const cleanedLine = buffer.trim();
    if (cleanedLine.startsWith("data: ")) {
      const dataStr = cleanedLine.substring(6).trim();
      if (dataStr !== "[DONE]") {
        try {
          const parsed = JSON.parse(dataStr);
          
          let chunkContent = parsed.choices?.[0]?.delta?.content || "";
          let chunkReasoning = parsed.choices?.[0]?.delta?.reasoning_content || "";
          if (!chunkContent && parsed.type === "content_block_delta" && parsed.delta?.text) {
            chunkContent = parsed.delta.text;
          }
          
          if (chunkReasoning) {
            try { port.postMessage({ action: "think", text: chunkReasoning }); } catch (_) {}
          }
          if (chunkContent) {
            try { port.postMessage({ action: "chunk", text: chunkContent }); } catch (_) {}
          }
        } catch (err) {
          // ignore partial JSON errors at the very end
        }
      }
    }
  }

  try { port.postMessage({ action: "done" }); } catch (_) {}
}

// Simulate AI Streaming for no-key testing mode
async function handleMockStream(text, port) {
  const mockReply = `这是一个**模拟 AI 解析结果**。

您目前处于 **"Mock 模拟体验模式"**。此模式不需要配置任何 API Key，方便您快速测试插件的界面交互、弹窗及一键复制等各项功能。

### 📌 您当前选中的文本是：
**"${text}"**

### 💡 选项与文本解析模拟：
1. **界面交互正常**：弹窗使用了 Shadow DOM 隔离技术，所以在任意复杂的网页上都不会出现样式错乱。
2. **打字流式效果**：您当前看到的打字效果就是正式版所使用的流式（Streaming）生成技术，体验极其流畅。
3. **下一步操作**：
   - 拖拽弹窗顶部的空白区域，可以随意移动弹窗。
   - 点击底部的 **"复制"** 按钮，可将此处的所有解析文本一键复制。
   - 点击右上角的 **"-"**，可临时折叠窗口，方便查看原网页；点击 **"X"** 关闭。

### 🔑 如何开启真实的 AI 回答？
1. 点击浏览器右上角的插件图标，进入 **"设置中心"**。
2. 将服务商切换为 **Gemini**、**DeepSeek** 或 **OpenAI**。
3. 输入您申请的 **API Key**，然后保存配置。
   *提示：Gemini 的 API Key 可以在 Google AI Studio 免费申请，速度极快！*

祝您体验愉快！`;

  const chunkSize = 8;
  let offset = 0;
  
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      try {
        if (offset >= mockReply.length) {
          clearInterval(interval);
          port.postMessage({ action: "done" });
          resolve();
          return;
        }
        
        const chunk = mockReply.substring(offset, offset + chunkSize);
        offset += chunkSize;
        port.postMessage({ action: "chunk", text: chunk });
      } catch (e) {
        clearInterval(interval);
        resolve();
      }
    }, 30);
  });
}

// Perform a single connection test request headlessly from background context (bypasses CORS/CSP restrictions)
async function performConnectionTest(settings) {
  const provider = settings.provider || "mock";
  const apiKey = settings.apiKey;
  const systemPrompt = "你是个助手。";

  if (provider === "mock") {
    return "模拟连接测试成功！";
  }

  if (!apiKey) {
    throw new Error("请先输入 API Key。");
  }

  let url = "";
  let modelName = settings.model;
  let headers = {
    "Content-Type": "application/json"
  };

  switch (provider) {
    case "gemini":
      modelName = modelName || "gemini-2.5-flash";
      // [Bug7 Fix] Only use Bearer token
      url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "anthropic":
      modelName = modelName || "claude-3-5-sonnet-latest";
      // [Bug2 Fix] Use helper to correctly build URL
      url = buildAnthropicUrl(settings.endpoint, "messages");
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "openai":
    default:
      modelName = modelName || "gpt-4o-mini";
      url = buildOpenAIUrl(settings.endpoint, "chat/completions");
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
  }

  let testRequestBody;
  if (provider === "anthropic") {
    testRequestBody = {
      model: modelName,
      messages: [
        { role: "user", content: "Hi" }
      ],
      max_tokens: 10,
      stream: false
    };
  } else {
    testRequestBody = {
      model: modelName,
      messages: [
        { role: "user", content: "Hi" }
      ],
      stream: false
    };

    // If using OpenAI protocol but model/endpoint contains 'deepseek', control thinking toggle
    if (modelName.toLowerCase().includes("deepseek") || url.toLowerCase().includes("deepseek")) {
      testRequestBody.thinking = {
        type: settings.enableThinking ? "enabled" : "disabled"
      };
    }
  }

  // [Edge2 Fix] Add timeout for connection test
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(testRequestBody),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("连接测试超时（15秒无响应），请检查网络和 API 地址。");
    }
    throw err;
  }

  if (!response.ok) {
    let errMsg = `HTTP 错误 ${response.status}`;
    try {
      const errorJson = await response.json();
      errMsg = errorJson.error?.message || errorJson.message || errMsg;
    } catch (_) {
      try {
        const errorText = await response.text();
        errMsg = errorText || errMsg;
      } catch (_) {}
    }
    throw new Error(errMsg);
  }

  const data = await response.json();
  
  // Try OpenAI format first
  let content = data.choices?.[0]?.message?.content;
  
  // Try Anthropic format next
  if (!content && data.content && data.content[0] && data.content[0].text) {
    content = data.content[0].text;
  }

  return content || "无回复";
}

// Fetch available models from standard API endpoints
async function fetchModelsFromApi(settings) {
  const provider = settings.provider || "openai";
  const apiKey = settings.apiKey;
  let url = "";
  let headers = {};

  if (provider === "gemini") {
    // Gemini models API uses key param (not OpenAI-compat, so key-in-URL is required)
    url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  } else if (provider === "anthropic") {
    // [Bug2 Fix] Use helper for consistent URL building
    url = buildAnthropicUrl(settings.endpoint, "models");
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    // openai
    let baseUrl = (settings.endpoint || "https://api.openai.com/v1").replace(/\/+$/, "");
    if (!baseUrl.endsWith("/models")) {
      // Remove /chat/completions if present
      baseUrl = baseUrl.replace(/\/chat\/completions$/, "");
      if (!baseUrl.endsWith("/models")) {
        url = baseUrl + "/models";
      } else {
        url = baseUrl;
      }
    } else {
      url = baseUrl;
    }
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  console.log(`AI Selection Helper: Fetching models list from ${url}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: headers,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("拉取模型列表超时（15秒无响应）。");
    }
    throw err;
  }

  if (!response.ok) {
    throw new Error(`HTTP 错误 ${response.status}`);
  }

  const data = await response.json();
  let models = [];

  if (provider === "gemini") {
    // Gemini formats models list as: { "models": [ { "name": "models/gemini-1.5-flash", ... } ] }
    if (data.models && Array.isArray(data.models)) {
      models = data.models.map(m => m.name.replace(/^models\//, ""));
    }
  } else if (provider === "anthropic") {
    // Anthropic formats as: { "data": [ { "id": "claude-3-5-sonnet-20241022", ... } ] }
    if (data.data && Array.isArray(data.data)) {
      models = data.data.map(m => m.id);
    }
  } else {
    // OpenAI / SiliconFlow formats as: { "data": [ { "id": "gpt-4o", ... } ] }
    if (data.data && Array.isArray(data.data)) {
      models = data.data.map(m => m.id);
    }
  }

  // Sort alphabetically
  models.sort();
  return models;
}

