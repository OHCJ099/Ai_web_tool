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
  customShortcut: "",
  enableSuperCopy: false
};

// Help text configurations for key
const KEY_HELP_TEXTS = {
  mock: "体验模式无需 API Key，保存后即可在网页上直接体验 AI 弹窗效果！",
  gemini: "Gemini API Key 可在 Google AI Studio 免费申请并获取，免费层支持每分钟 15 次调用。",
  anthropic: "Anthropic API Key 可在其 Console 平台获取，使用 Claude 系列模型时配置。",
  openai: "OpenAI 兼容协议支持官方 OpenAI、DeepSeek、SiliconFlow 等中转接口。请输入对应的 API Key。"
};

// Default recommendations
// [Bug2 Fix] Anthropic default endpoint changed to bare domain (without /v1)
const PROVIDER_DEFAULTS = {
  mock: {
    model: "mock-ai-model",
    endpoint: ""
  },
  gemini: {
    model: "gemini-2.5-flash",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai"
  },
  anthropic: {
    model: "claude-3-5-sonnet-latest",
    endpoint: "https://api.anthropic.com"
  },
  openai: {
    model: "deepseek-ai/DeepSeek-V4-Flash",
    endpoint: "https://api.siliconflow.cn/v1"
  }
};

const INITIAL_PRESETS = {
  "siliconflow-deepseek": {
    name: "✨ SiliconFlow - DeepSeek-V4-Flash",
    provider: "openai",
    apiKey: "",
    endpoint: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V4-Flash",
    systemPrompt: "你是一个最极简的答题机器。不要解析，不要原理，只给最终答案：\n1. 选择题/多选题：只输出正确选项字母（如：A），不要任何其他文字。\n2. 判断题：只输出【对】或【错】，不要解析。\n3. 其他题目：仅用一句话回答核心答案，字数控制在 50 字以内。",
    enableThinking: false,
    fontColor: "#000000",
    fontSize: "15",
    fontWeight: "400",
    fontOpacity: "100",
    customShortcut: ""
  }
};

document.addEventListener("DOMContentLoaded", () => {
  // Select DOM Elements
  const providerSelect = document.getElementById("provider");
  const apiKeyInput = document.getElementById("api-key");
  const endpointGroup = document.getElementById("endpoint-group");
  const endpointInput = document.getElementById("endpoint");
  const modelInput = document.getElementById("model");
  const systemPromptInput = document.getElementById("system-prompt");
  const themeSelect = document.getElementById("theme");
  const enableSuperCopyInput = document.getElementById("enable-supercopy");
  const fontColorInput = document.getElementById("font-color");
  const fontColorHexInput = document.getElementById("font-color-hex");
  const fontSizeInput = document.getElementById("font-size");
  const fontWeightSelect = document.getElementById("font-weight");
  const fontOpacityInput = document.getElementById("font-opacity");
  const fontOpacityVal = document.getElementById("font-opacity-val");
  const customShortcutInput = document.getElementById("custom-shortcut");
  const btnClearShortcut = document.getElementById("btn-clear-shortcut");
  
  const toggleKeyBtn = document.getElementById("toggle-key-visibility");
  const keyHelpText = document.getElementById("key-help-text");
  
  const btnSave = document.getElementById("btn-save");
  const btnTest = document.getElementById("btn-test");
  const toast = document.getElementById("toast");
  
  const testResultCard = document.getElementById("test-result");
  const testStatusIndicator = document.getElementById("test-status-indicator");
  const testResultTitle = document.getElementById("test-result-title");
  const testResultContent = document.getElementById("test-result-content");

  // Presets Elements
  const presetSelect = document.getElementById("preset-select");
  const btnAddPreset = document.getElementById("btn-add-preset");
  const btnDeletePreset = document.getElementById("btn-delete-preset");
  const btnFetchModels = document.getElementById("btn-fetch-models");
  const enableThinkingInput = document.getElementById("enable-thinking");
  const modelSelect = document.getElementById("model-select");

  // Track provider change to update view and pre-fills
  let lastSelectedProvider = "";
  let allPresets = {};
  // [Flow4 Fix] Flag to prevent storage listener feedback loop
  let isSaving = false;

  function loadPresetsList(selectedKey = "") {
    chrome.storage.local.get({ presets: INITIAL_PRESETS, currentPreset: "" }, (res) => {
      allPresets = res.presets;
      
      // Save it back to storage to ensure it exists
      chrome.storage.local.set({ presets: allPresets });

      const activePresetKey = selectedKey || res.currentPreset;

      // Clear except the first option
      presetSelect.innerHTML = '<option value="">-- 选择或载入预设 --</option>';

      // Populate select
      for (const [key, preset] of Object.entries(allPresets)) {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = preset.name;
        presetSelect.appendChild(option);
      }

      if (activePresetKey && allPresets[activePresetKey]) {
        presetSelect.value = activePresetKey;
        toggleDeleteButton(activePresetKey);
      } else {
        matchCurrentSettingsToPreset();
      }
    });
  }

  function toggleDeleteButton(key) {
    if (key) {
      btnDeletePreset.style.display = "block";
    } else {
      btnDeletePreset.style.display = "none";
    }
  }

  function matchCurrentSettingsToPreset() {
    const currentProvider = providerSelect.value;
    const currentKey = apiKeyInput.value.trim();
    const currentEndpoint = endpointInput.value.trim();
    const currentModel = modelInput.value.trim();
    const currentThinking = enableThinkingInput.checked;

    for (const [key, preset] of Object.entries(allPresets)) {
      if (preset.provider === currentProvider &&
          preset.apiKey === currentKey &&
          (preset.endpoint || "") === (currentEndpoint || "") &&
          preset.model === currentModel &&
          (preset.enableThinking || false) === currentThinking) {
        presetSelect.value = key;
        toggleDeleteButton(key);
        return;
      }
    }
    presetSelect.value = "";
    btnDeletePreset.style.display = "none";
  }

  // 1. Load Settings
  chrome.storage.local.get({ ...DEFAULTS, loadPresetOnOpen: false }, (settings) => {
    chrome.storage.local.get({ presets: INITIAL_PRESETS }, (presetsRes) => {
      const presets = presetsRes.presets;
      const activePresetKey = settings.currentPreset;
      
      let currentProvider = settings.provider;
      let currentApiKey = settings.apiKey;
      let currentEndpoint = settings.endpoint;
      let currentModel = settings.model;
      let currentSystemPrompt = settings.systemPrompt;
      let currentEnableThinking = settings.enableThinking || false;
      let currentFontColor = settings.fontColor || "#000000";
      let currentFontSize = settings.fontSize || "15";
      let currentFontWeight = settings.fontWeight || "400";
      let currentFontOpacity = settings.fontOpacity || "100";
      let currentCustomShortcut = settings.customShortcut || "";

      // If we are opening option page from preset change in popup, load the preset values
      if (settings.loadPresetOnOpen && activePresetKey && presets[activePresetKey]) {
        const preset = presets[activePresetKey];
        currentProvider = preset.provider;
        currentApiKey = preset.apiKey;
        currentEndpoint = preset.endpoint || "";
        currentModel = preset.model;
        currentSystemPrompt = preset.systemPrompt;
        currentEnableThinking = preset.enableThinking || false;
        currentFontColor = preset.fontColor || "#000000";
        currentFontSize = preset.fontSize || "15";
        currentFontWeight = preset.fontWeight || "400";
        currentFontOpacity = preset.fontOpacity || "100";
        currentCustomShortcut = preset.customShortcut || "";

        // Clear the one-time redirect flag
        chrome.storage.local.set({ loadPresetOnOpen: false });
      }

      providerSelect.value = currentProvider;
      apiKeyInput.value = currentApiKey;
      endpointInput.value = currentEndpoint;
      modelInput.value = currentModel;
      systemPromptInput.value = currentSystemPrompt;
      themeSelect.value = settings.theme;
      enableSuperCopyInput.checked = settings.enableSuperCopy || false;
      enableThinkingInput.checked = currentEnableThinking;
      fontColorInput.value = currentFontColor;
      fontColorHexInput.value = currentFontColor;
      fontSizeInput.value = currentFontSize;
      fontWeightSelect.value = currentFontWeight;
      fontOpacityInput.value = currentFontOpacity;
      fontOpacityVal.innerText = currentFontOpacity + "%";
      customShortcutInput.value = currentCustomShortcut;

      lastSelectedProvider = currentProvider;
      adjustUIByProvider(currentProvider, false);

      // Load presets
      loadPresetsList(activePresetKey);
    });
  });

  // Synced color input and hex text input
  fontColorInput.addEventListener("input", () => {
    fontColorHexInput.value = fontColorInput.value;
  });

  fontColorHexInput.addEventListener("input", () => {
    const val = fontColorHexInput.value.trim();
    if (/^#[0-9A-F]{6}$/i.test(val)) {
      fontColorInput.value = val;
    }
  });

  // 2. Listen to Provider Change
  providerSelect.addEventListener("change", () => {
    const provider = providerSelect.value;
    adjustUIByProvider(provider, true);
    lastSelectedProvider = provider;
  });

  // [Bug4 Fix] Preset Select Listener - NO longer auto-saves, just fills the form
  presetSelect.addEventListener("change", () => {
    const selectedKey = presetSelect.value;
    if (!selectedKey) {
      btnDeletePreset.style.display = "none";
      return;
    }

    const preset = allPresets[selectedKey];
    if (preset) {
      providerSelect.value = preset.provider;
      apiKeyInput.value = preset.apiKey;
      endpointInput.value = preset.endpoint || "";
      modelInput.value = preset.model;
      systemPromptInput.value = preset.systemPrompt;
      enableThinkingInput.checked = preset.enableThinking || false;
      fontColorInput.value = preset.fontColor || "#000000";
      fontColorHexInput.value = preset.fontColor || "#000000";
      fontSizeInput.value = preset.fontSize || "15";
      fontWeightSelect.value = preset.fontWeight || "400";
      fontOpacityInput.value = preset.fontOpacity || "100";
      fontOpacityVal.innerText = (preset.fontOpacity || "100") + "%";
      customShortcutInput.value = preset.customShortcut || "";

      adjustUIByProvider(preset.provider, false);
      toggleDeleteButton(selectedKey);
      
      // Only fill the form, do NOT auto-save
      showToast(`已载入预设: ${preset.name}（点击"保存"生效）`);
    }
  });

  // Add new preset
  btnAddPreset.addEventListener("click", () => {
    const presetName = prompt("请输入新预设的名称 (例如: 我的 SiliconFlow 配置):");
    if (!presetName) return;

    const trimmedName = presetName.trim();
    if (!trimmedName) return;

    const presetKey = "custom-" + Date.now();
    const newPreset = {
      name: "👤 " + trimmedName,
      provider: providerSelect.value,
      apiKey: apiKeyInput.value.trim(),
      endpoint: endpointInput.value.trim(),
      model: modelInput.value.trim(),
      systemPrompt: systemPromptInput.value.trim(),
      enableThinking: enableThinkingInput.checked,
      fontColor: fontColorInput.value,
      fontSize: fontSizeInput.value,
      fontWeight: fontWeightSelect.value,
      fontOpacity: fontOpacityInput.value,
      customShortcut: customShortcutInput.value,
      isBuiltin: false
    };

    chrome.storage.local.get({ presets: INITIAL_PRESETS }, (res) => {
      const presets = res.presets;
      presets[presetKey] = newPreset;
      chrome.storage.local.set({ presets, currentPreset: presetKey }, () => {
        showToast("新预设已成功添加并载入！");
        loadPresetsList(presetKey);
      });
    });
  });

  // [Bug5 Fix] Delete preset - warn if form has unsaved changes
  btnDeletePreset.addEventListener("click", () => {
    const selectedKey = presetSelect.value;
    if (!selectedKey) return;

    if (!confirm(`确定要删除预设 "${allPresets[selectedKey].name}" 吗？`)) return;

    // Check if form has unsaved changes relative to the active config
    chrome.storage.local.get(DEFAULTS, (currentSettings) => {
      const formProvider = providerSelect.value;
      const formKey = apiKeyInput.value.trim();
      const formEndpoint = endpointInput.value.trim();
      const formModel = modelInput.value.trim();
      const formPrompt = systemPromptInput.value.trim();
      const formThinking = enableThinkingInput.checked;

      const hasUnsavedChanges =
        currentSettings.provider !== formProvider ||
        currentSettings.apiKey !== formKey ||
        (currentSettings.endpoint || "") !== formEndpoint ||
        currentSettings.model !== formModel ||
        currentSettings.systemPrompt !== formPrompt ||
        (currentSettings.enableThinking || false) !== formThinking;

      if (hasUnsavedChanges) {
        if (!confirm("当前表单中有未保存的修改，删除预设后这些修改将丢失。是否继续？")) return;
      }

      chrome.storage.local.get({ presets: INITIAL_PRESETS }, (res) => {
        const presets = res.presets;
        delete presets[selectedKey];
        
        const remainingKeys = Object.keys(presets);
        const nextPresetKey = remainingKeys.length > 0 ? remainingKeys[0] : "";
        const nextPreset = nextPresetKey ? presets[nextPresetKey] : null;
        
        const saveData = { presets, currentPreset: nextPresetKey };
        
        // [Bug5 Fix] Also sync the active config to the next preset's values
        if (nextPreset) {
          saveData.provider = nextPreset.provider;
          saveData.apiKey = nextPreset.apiKey;
          saveData.endpoint = nextPreset.endpoint || "";
          saveData.model = nextPreset.model;
          saveData.systemPrompt = nextPreset.systemPrompt;
          saveData.enableThinking = nextPreset.enableThinking || false;
        }
        
        isSaving = true;
        chrome.storage.local.set(saveData, () => {
          isSaving = false;
          showToast("预设已成功删除！");
          
          if (nextPreset) {
            providerSelect.value = nextPreset.provider;
            apiKeyInput.value = nextPreset.apiKey;
            endpointInput.value = nextPreset.endpoint || "";
            modelInput.value = nextPreset.model;
            systemPromptInput.value = nextPreset.systemPrompt;
            enableThinkingInput.checked = nextPreset.enableThinking || false;
            lastSelectedProvider = nextPreset.provider;
            adjustUIByProvider(nextPreset.provider, false);
          }
          loadPresetsList(nextPresetKey);
        });
      });
    });
  });

  // [Flow2 Fix] Smart provider change - preserve user custom values
  function adjustUIByProvider(provider, isUserChanged) {
    // Show/Hide endpoint input
    if (provider === "gemini" || provider === "mock") {
      endpointGroup.style.display = "none";
    } else {
      endpointGroup.style.display = "block";
    }

    // Enable/disable API key input for mock
    if (provider === "mock") {
      apiKeyInput.disabled = true;
      apiKeyInput.placeholder = "无需 API Key (体验模式)";
    } else {
      apiKeyInput.disabled = false;
      apiKeyInput.placeholder = "输入您申请的 API Key";
    }

    // Set helper text
    keyHelpText.innerText = KEY_HELP_TEXTS[provider] || "";

    // Pre-fill model and endpoint defaults on provider switch
    if (isUserChanged) {
      const currentModel = modelInput.value.trim();
      const currentEndpoint = endpointInput.value.trim();

      // [Flow2 Fix] Only auto-fill if current value is empty or matches the PREVIOUS provider's default
      const lastDefaults = PROVIDER_DEFAULTS[lastSelectedProvider] || {};
      const newDefaults = PROVIDER_DEFAULTS[provider] || {};
      
      if (!currentModel || currentModel === (lastDefaults.model || "")) {
        modelInput.value = newDefaults.model || "";
      }
      if (!currentEndpoint || currentEndpoint === (lastDefaults.endpoint || "")) {
        endpointInput.value = newDefaults.endpoint || "";
      }
    }
  }

  // 3. Toggle API Key visibility
  toggleKeyBtn.addEventListener("click", () => {
    const type = apiKeyInput.type === "password" ? "text" : "password";
    apiKeyInput.type = type;
    
    // Change SVG icon inside button
    if (type === "text") {
      toggleKeyBtn.innerHTML = `
        <svg viewBox="0 0 24 24" id="eye-icon"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
      `;
    } else {
      toggleKeyBtn.innerHTML = `
        <svg viewBox="0 0 24 24" id="eye-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
      `;
    }
  });

  // [Bug3 + Bug6 Fix] 4. Save Settings - decoupled from preset modification
  btnSave.addEventListener("click", () => {
    const provider = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();
    const endpoint = endpointInput.value.trim();
    const model = modelInput.value.trim();
    const systemPrompt = systemPromptInput.value.trim();
    const showFloatButton = false;
    const theme = themeSelect.value;
    const enableSuperCopy = enableSuperCopyInput.checked;
    const enableThinking = enableThinkingInput.checked;
    const fontColor = fontColorInput.value;
    const fontSize = fontSizeInput.value;
    const fontWeight = fontWeightSelect.value;
    const fontOpacity = fontOpacityInput.value;
    const customShortcut = customShortcutInput.value;

    // [Edge8 Fix] Validate endpoint URL format
    if (provider !== "mock" && provider !== "gemini" && endpoint) {
      try {
        new URL(endpoint);
      } catch (e) {
        alert("接口地址格式不正确，请输入有效的 HTTP(S) URL。\n\n例如: https://api.openai.com/v1");
        return;
      }
      if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
        alert("接口地址必须以 http:// 或 https:// 开头。");
        return;
      }
    }

    const selectedPresetKey = presetSelect.value;

    chrome.storage.local.get({ presets: INITIAL_PRESETS }, (res) => {
      const presets = res.presets;
      let presetUpdated = false;
      
      // [Bug3 Fix] Only update preset if user explicitly confirms
      if (selectedPresetKey && presets[selectedPresetKey]) {
        const preset = presets[selectedPresetKey];
        const hasChanges = preset.provider !== provider ||
            preset.apiKey !== apiKey ||
            (preset.endpoint || "") !== endpoint ||
            preset.model !== model ||
            preset.systemPrompt !== systemPrompt ||
            (preset.enableThinking || false) !== enableThinking ||
            preset.fontColor !== fontColor ||
            preset.fontSize !== fontSize ||
            preset.fontWeight !== fontWeight ||
            preset.fontOpacity !== fontOpacity ||
            preset.customShortcut !== customShortcut;
        
        if (hasChanges) {
          if (confirm(`当前配置与预设 "${preset.name}" 不同，是否同时更新该预设？\n\n选择"取消"将仅保存当前配置而不修改预设。`)) {
            presets[selectedPresetKey].provider = provider;
            presets[selectedPresetKey].apiKey = apiKey;
            presets[selectedPresetKey].endpoint = endpoint;
            presets[selectedPresetKey].model = model;
            presets[selectedPresetKey].systemPrompt = systemPrompt;
            presets[selectedPresetKey].enableThinking = enableThinking;
            presets[selectedPresetKey].fontColor = fontColor;
            presets[selectedPresetKey].fontSize = fontSize;
            presets[selectedPresetKey].fontWeight = fontWeight;
            presets[selectedPresetKey].fontOpacity = fontOpacity;
            presets[selectedPresetKey].customShortcut = customShortcut;
            presetUpdated = true;
          }
        }
      }

      isSaving = true;
      chrome.storage.local.set({
        provider,
        apiKey,
        endpoint,
        model,
        systemPrompt,
        showFloatButton,
        theme,
        enableSuperCopy,
        enableThinking,
        fontColor,
        fontSize,
        fontWeight,
        fontOpacity,
        customShortcut,
        presets,
        currentPreset: selectedPresetKey
      }, () => {
        isSaving = false;
        // [Bug6 Fix] Show accurate toast message
        if (presetUpdated) {
          showToast("设置已保存，对应预设已同步更新！");
        } else {
          showToast("设置已保存！");
        }
        loadPresetsList(selectedPresetKey);
      });
    });
  });

  // 5. Fetch Models list dynamically
  btnFetchModels.addEventListener("click", () => {
    const provider = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();
    let endpoint = endpointInput.value.trim();

    if (provider === "mock") {
      showToast("Mock 模式不支持拉取模型列表。");
      return;
    }
    if (!apiKey) {
      alert("请先配置并保存您的 API Key 再拉取模型！");
      return;
    }

    btnFetchModels.innerText = "拉取中...";
    btnFetchModels.disabled = true;

    chrome.runtime.sendMessage({
      action: "FETCH_API_MODELS",
      settings: { provider, apiKey, endpoint }
    }, (response) => {
      btnFetchModels.innerText = "拉取模型列表";
      btnFetchModels.disabled = false;

      if (chrome.runtime.lastError) {
        alert("拉取模型失败！\n原因：" + chrome.runtime.lastError.message);
        return;
      }

      if (response && response.success && response.models && response.models.length > 0) {
        // Clear options except placeholder
        modelSelect.innerHTML = '<option value="">-- 选择已拉取的模型 --</option>';
        
        response.models.forEach(modelId => {
          const option = document.createElement("option");
          option.value = modelId;
          option.textContent = modelId;
          modelSelect.appendChild(option);
        });

        // Show the select dropdown
        modelSelect.style.display = "block";

        showToast(`已成功识别 ${response.models.length} 个可用模型！`);
        
        // Auto-select first model if the input is currently blank
        if (!modelInput.value.trim()) {
          modelInput.value = response.models[0];
          modelSelect.value = response.models[0];
        } else {
          // If the model input is not empty, try to match the select option
          if (response.models.includes(modelInput.value.trim())) {
            modelSelect.value = modelInput.value.trim();
          }
        }
      } else {
        const errMsg = response ? response.error : "未知错误";
        alert("拉取模型失败！\n接口返回原因：" + errMsg);
      }
    });
  });

  // Handle model selection from the select dropdown
  modelSelect.addEventListener("change", () => {
    const selectedModel = modelSelect.value;
    if (selectedModel) {
      modelInput.value = selectedModel;
    }
  });

  // [Flow1 Fix] Thinking toggle feedback for non-DeepSeek models
  enableThinkingInput.addEventListener("change", () => {
    if (enableThinkingInput.checked) {
      const model = modelInput.value.trim().toLowerCase();
      if (!model.includes("deepseek")) {
        showToast("⚠️ 当前模型不支持深度思考，此开关将不生效");
      }
    }
  });

  // Helper to show save confirmation toast
  function showToast(message) {
    toast.innerText = message;
    toast.classList.add("show");
    setTimeout(() => {
      toast.classList.remove("show");
    }, 2500);
  }

  // 6. Test Connection
  btnTest.addEventListener("click", () => {
    const provider = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();
    let endpoint = endpointInput.value.trim();
    let model = modelInput.value.trim();

    if (provider === "mock") {
      showTestResult("loading", "正在发起模拟连接测试，请稍候...");
      setTimeout(() => {
        showTestResult("success", "模拟测试成功！在网页上选中文字并点击 AI 气泡，即可体验完美的流式解析弹窗。若要获取真实 AI 回答，请切换为 Gemini/DeepSeek 并填入您的 API Key。");
      }, 800);
      return;
    }

    if (!apiKey) {
      showTestResult("error", "测试失败: 请先填写 API Key！");
      return;
    }

    showTestResult("loading", "正在发起 API 连接测试，请稍候...");

    chrome.runtime.sendMessage({
      action: "TEST_API_CONNECTION",
      settings: { provider, apiKey, endpoint, model }
    }, (response) => {
      // Check for background script availability or loading errors
      if (chrome.runtime.lastError) {
        // [Edge4 Fix] Use textContent for error messages to prevent XSS
        showTestResult("error", `连接测试失败！错误详情: ${chrome.runtime.lastError.message} (请前往 chrome://extensions 页面刷新插件后再试)`);
        return;
      }

      if (response && response.success) {
        showTestResult("success", `连接成功！AI 成功回复："${response.reply.trim()}"`);
      } else {
        const errMsg = response ? response.error : "发送消息超时或无响应";
        showTestResult("error", `连接测试失败！错误详情: ${errMsg}`);
      }
    });
  });

  // [Edge4 Fix] Display test results using textContent instead of innerHTML for dynamic content
  function showTestResult(type, message) {
    testResultCard.classList.remove("hidden");
    
    // Reset classes
    testStatusIndicator.className = "status-indicator";
    testResultCard.className = "card result-card animate-fade-in";
    
    if (type === "loading") {
      testStatusIndicator.classList.add("loading");
      testResultTitle.innerText = "连接测试中...";
      testResultContent.innerHTML = `<div class="testing-spinner"></div>`;
      const p = document.createElement("p");
      p.textContent = message;
      testResultContent.appendChild(p);

      const note = document.createElement("div");
      note.style.marginTop = "8px";
      note.style.fontSize = "11px";
      note.style.color = "#854d0e";
      note.style.background = "#fef9c3";
      note.style.border = "1px solid #fef08a";
      note.style.padding = "6px 10px";
      note.style.borderRadius = "4px";
      note.textContent = "💡 提示：测试使用的是当前表单上填写的临时参数。测试成功后，必须点击右下角【保存设置】才能正式生效！";
      testResultContent.appendChild(note);
    } 
    else if (type === "success") {
      testStatusIndicator.classList.add("success");
      testResultTitle.innerText = "测试通过";
      const p = document.createElement("p");
      p.style.color = "#10b981";
      p.style.fontWeight = "500";
      p.textContent = message;
      testResultContent.innerHTML = "";
      testResultContent.appendChild(p);
      
      const note = document.createElement("div");
      note.style.marginTop = "8px";
      note.style.fontSize = "11px";
      note.style.color = "#15803d";
      note.style.background = "#dcfce7";
      note.style.border = "1px solid #bbf7d0";
      note.style.padding = "6px 10px";
      note.style.borderRadius = "4px";
      note.textContent = "💡 提示：连接成功！当前使用的是表单临时参数，请记得点击右下角【保存设置】。";
      testResultContent.appendChild(note);

      testResultCard.classList.add("border-success");
    } 
    else if (type === "error") {
      testStatusIndicator.classList.add("error");
      testResultTitle.innerText = "测试失败";
      const p = document.createElement("p");
      p.textContent = message;
      testResultContent.innerHTML = "";
      testResultContent.appendChild(p);
      testResultCard.classList.add("border-error");
    }
  }

  // [Flow4 Fix] Listen for external storage changes (e.g., from popup preset switch)
  chrome.storage.onChanged.addListener((changes) => {
    if (isSaving) return; // Skip if we triggered this change ourselves
    
    // Check if relevant settings changed externally
    if (changes.currentPreset || changes.provider || changes.apiKey || changes.model || changes.fontColor || changes.fontSize || changes.fontWeight || changes.fontOpacity || changes.customShortcut || changes.enableSuperCopy) {
      chrome.storage.local.get(DEFAULTS, (settings) => {
        providerSelect.value = settings.provider;
        apiKeyInput.value = settings.apiKey;
        endpointInput.value = settings.endpoint;
        modelInput.value = settings.model;
        systemPromptInput.value = settings.systemPrompt;
        themeSelect.value = settings.theme;
        enableSuperCopyInput.checked = settings.enableSuperCopy || false;
        enableThinkingInput.checked = settings.enableThinking || false;
        fontColorInput.value = settings.fontColor || "#000000";
        fontColorHexInput.value = settings.fontColor || "#000000";
        fontSizeInput.value = settings.fontSize || "15";
        fontWeightSelect.value = settings.fontWeight || "400";
        fontOpacityInput.value = settings.fontOpacity || "100";
        fontOpacityVal.innerText = (settings.fontOpacity || "100") + "%";
        customShortcutInput.value = settings.customShortcut || "";

        lastSelectedProvider = settings.provider;
        adjustUIByProvider(settings.provider, false);
        loadPresetsList(settings.currentPreset);
      });
    }
  });

  // Dynamic Opacity slider label update
  fontOpacityInput.addEventListener("input", () => {
    fontOpacityVal.innerText = fontOpacityInput.value + "%";
  });

  // Shortcut Recording Logic
  customShortcutInput.addEventListener("focus", () => {
    customShortcutInput.classList.add("recording");
    customShortcutInput.value = "";
    customShortcutInput.placeholder = "请按下组合键...";
  });

  customShortcutInput.addEventListener("blur", () => {
    customShortcutInput.classList.remove("recording");
    if (!customShortcutInput.value) {
      chrome.storage.local.get({ customShortcut: "" }, (res) => {
        customShortcutInput.value = res.customShortcut;
      });
    }
  });

  customShortcutInput.addEventListener("keydown", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const modifiers = [];
    if (e.ctrlKey) modifiers.push("Ctrl");
    if (e.altKey) modifiers.push("Alt");
    if (e.shiftKey) modifiers.push("Shift");
    if (e.metaKey) modifiers.push("Meta");

    const key = e.key;
    if (key !== "Control" && key !== "Alt" && key !== "Shift" && key !== "Meta") {
      let displayKey = key;
      if (displayKey.length === 1) {
        displayKey = displayKey.toUpperCase();
      }
      modifiers.push(displayKey);
      customShortcutInput.value = modifiers.join("+");
      customShortcutInput.blur(); // Trigger blur to exit recording mode
    }
  });

  btnClearShortcut.addEventListener("click", () => {
    customShortcutInput.value = "";
    customShortcutInput.placeholder = "点击录制快捷键，如 Alt+Q";
  });

  document.getElementById("link-chrome-shortcuts").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
});
