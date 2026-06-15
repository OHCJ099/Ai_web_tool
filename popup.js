const INITIAL_PRESETS = {
  "siliconflow-deepseek": {
    name: "✨ SiliconFlow - DeepSeek-V4-Flash",
    provider: "openai",
    apiKey: "",
    endpoint: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V4-Flash",
    systemPrompt: "你是一个最极简的答题机器。不要解析，不要原理，只给最终答案：\n1. 选择题/多选题：只输出正确选项字母（如：A），不要任何其他文字。\n2. 判断题：只输出【对】或【错】，不要解析。\n3. 其他题目：仅用一句话回答核心答案，字数控制在 50 字以内。",
    enableThinking: false
  }
};

document.addEventListener("DOMContentLoaded", () => {
  const currentProvider = document.getElementById("current-provider");
  const statusDot = document.getElementById("status-dot");
  const statusDesc = document.getElementById("status-desc");
  const btnOpenOptions = document.getElementById("btn-open-options");
  const popupPresetSelect = document.getElementById("popup-preset-select");

  let allPresets = {};

  const providerNames = {
    mock: "Mock 模拟协议",
    gemini: "Gemini 协议",
    anthropic: "Anthropic 协议",
    openai: "OpenAI 协议"
  };

  // Helper function to update status display based on settings
  function updateStatusUI(settings) {
    const providerKey = settings.provider || "mock";
    currentProvider.innerText = providerNames[providerKey] || providerKey;

    if (providerKey === "mock") {
      statusDot.className = "status-dot success";
      statusDesc.innerText = "体验模式已就绪 (无需 Key)";
      statusDesc.style.color = "#10b981";
    } else if (!settings.apiKey) {
      statusDot.className = "status-dot error";
      statusDesc.innerHTML = "⚠️ 尚未配置 API Key";
      statusDesc.style.color = "#ef4444";
    } else {
      statusDot.className = "status-dot success";
      const modelName = settings.model || "gpt-4o-mini";
      statusDesc.innerText = `服务已就绪 (${modelName})`;
      statusDesc.style.color = "#10b981";
    }
  }

  // Load active settings and populate presets select
  function initPopup() {
    chrome.storage.local.get({
      provider: "openai",
      apiKey: "",
      endpoint: "https://api.siliconflow.cn/v1",
      model: "deepseek-ai/DeepSeek-V4-Flash",
      presets: INITIAL_PRESETS,
      currentPreset: "siliconflow-deepseek",
      enableThinking: false
    }, (settings) => {
      // Update UI Status
      updateStatusUI(settings);

      // Get presets from storage
      allPresets = settings.presets;

      // Populate Select
      popupPresetSelect.innerHTML = '<option value="">-- 选择或载入预设 --</option>';
      for (const [key, preset] of Object.entries(allPresets)) {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = preset.name;
        popupPresetSelect.appendChild(option);
      }

      // Try to find matching preset
      if (settings.currentPreset && allPresets[settings.currentPreset]) {
        popupPresetSelect.value = settings.currentPreset;
      } else {
        matchCurrentSettings(settings);
      }
    });
  }

  function matchCurrentSettings(settings) {
    const currentProvider = settings.provider;
    const currentKey = settings.apiKey ? settings.apiKey.trim() : "";
    const currentEndpoint = settings.endpoint ? settings.endpoint.trim() : "";
    const currentModel = settings.model ? settings.model.trim() : "";

    for (const [key, preset] of Object.entries(allPresets)) {
      if (preset.provider === currentProvider &&
          preset.apiKey === currentKey &&
          (preset.endpoint || "") === (currentEndpoint || "") &&
          preset.model === currentModel) {
        popupPresetSelect.value = key;
        return;
      }
    }
    popupPresetSelect.value = "";
  }

  // Listen to preset switch
  popupPresetSelect.addEventListener("change", () => {
    const selectedKey = popupPresetSelect.value;
    if (!selectedKey) return;

    const preset = allPresets[selectedKey];
    if (preset) {
      // Save currentPreset and set one-time redirect flag
      chrome.storage.local.set({
        currentPreset: selectedKey,
        loadPresetOnOpen: true
      }, () => {
        // Open Options page
        if (chrome.runtime.openOptionsPage) {
          chrome.runtime.openOptionsPage();
        } else {
          window.open(chrome.runtime.getURL("options.html"));
        }
      });
    }
  });

  // Run initial loading
  initPopup();

  // Open Options page
  btnOpenOptions.addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL("options.html"));
    }
  });
});
