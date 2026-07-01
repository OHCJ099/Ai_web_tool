(function () {
  // Prevent duplicate injection
  if (window.__autoAnswerLoaded) {
    console.log("[AutoAnswer] Already loaded, skipping.");
    return;
  }
  window.__autoAnswerLoaded = true;

  console.log("[AutoAnswer] Module loaded. URL:", window.location.href.substring(0, 80));

  // ==================== CONFIG ====================
  const MAX_QUESTIONS_PER_BATCH = 20;
  const AI_DELAY_MS = 1500; // Default delay between AI requests to avoid rate limits
  async function getAutoAnswerIntervalMs() {
    return await new Promise((resolve) => {
      chrome.storage.local.get({ autoAnswerIntervalMs: AI_DELAY_MS, aiAutoAnswerIntervalMs: AI_DELAY_MS }, (res) => {
        resolve(Math.max(300, Number(res.autoAnswerIntervalMs || res.aiAutoAnswerIntervalMs || AI_DELAY_MS) || AI_DELAY_MS));
      });
    });
  }
  function setDebugState(patch = {}) {
    chrome.storage.local.set(patch);
  }
  function getShortcutString(e) {
    const modifiers = [];
    if (e.ctrlKey) modifiers.push("Ctrl");
    if (e.altKey) modifiers.push("Alt");
    if (e.shiftKey) modifiers.push("Shift");
    if (e.metaKey) modifiers.push("Meta");
    const key = e.key;
    if (["Control", "Alt", "Shift", "Meta"].includes(key)) return "";
    modifiers.push(key.length === 1 ? key.toUpperCase() : key);
    return modifiers.join("+");
  }
  const BANK_MATCH_THRESHOLD = 0.55; // Minimum similarity to accept a bank match (0-1)

  // ==================== STATE ====================
  let isRunning = false;
  let progressPanel = null;
  let shadowRoot = null;
  let questionBank = [];        // Parsed question bank entries
  let questionBankLoaded = false;

  // ==================== QUESTION BANK ====================

  /**
   * Load and parse the question bank from 题库.txt.
   * Called once on startup. Returns a promise that resolves when loaded.
   */
  async function loadQuestionBank() {
    if (questionBankLoaded) return;

    try {
      const url = chrome.runtime.getURL("题库.txt");
      console.log("[AutoAnswer] Loading question bank from:", url);
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn("[AutoAnswer] Question bank not found or inaccessible, will use AI only.");
        questionBankLoaded = true;
        return;
      }
      const raw = await resp.text();
      questionBank = parseQuestionBank(raw);
      questionBankLoaded = true;
      console.log(`[AutoAnswer] Question bank loaded: ${questionBank.length} entries.`);
    } catch (err) {
      console.warn("[AutoAnswer] Failed to load question bank:", err.message);
      questionBankLoaded = true; // Mark as "loaded" to avoid retrying on every question
    }
  }

  /**
   * Parse the raw text of the question bank into structured entries.
   */
  function parseQuestionBank(raw) {
    const entries = [];
    const lines = raw.split(/\r?\n/);

    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();

      // Skip section headers like "一. 单选题（共 20 题，30.0 分）"
      if (/^[一二三四五六七八九十]+[\.、]/.test(line) && /题/.test(line)) {
        i++;
        continue;
      }

      // Match question start: "1. (单选题, ..." or "21. (填空题, ..."
      const qMatch = line.match(/^(\d+)\.\s*\(([^)]+)\)\s*(.*)/);
      if (qMatch) {
        const entry = {
          id: parseInt(qMatch[1]),
          rawType: qMatch[2].trim(),
          text: cleanQuestionText(qMatch[3].trim()),
          options: [],
          answer: "",
          answerTexts: []  // for fill-blank / multi-part answers
        };

        i++;
        // Read until next question or end of file
        while (i < lines.length) {
          const cur = lines[i];

          // Check if this line starts a new question
          const nextQ = cur.match(/^(\d+)\.\s*\(([^)]+)\)\s*(.*)/);
          if (nextQ) break;

          // Check if this line starts a new section
          if (/^[一二三四五六七八九十]+[\.、]/.test(cur.trim()) && /题/.test(cur.trim())) break;

          const trimmed = cur.trim();

          // Check for option lines (A./B./C./D.)
          const optMatch = trimmed.match(/^([A-D])\.\s+(.*)/);
          if (optMatch) {
            entry.options.push({
              letter: optMatch[1],
              text: optMatch[2].trim()
            });
            i++;
            continue;
          }

          // Check for answer line
          if (trimmed.startsWith("我的答案:")) {
            const ans = trimmed.replace("我的答案:", "").trim();
            entry.answer = ans;
            entry.answerTexts.push(ans);
            i++;

            // For fill-blank: read subsequent non-empty lines that look like answers
            while (i < lines.length) {
              const ansLine = lines[i].trim();
              // Stop at next question, section header, or option
              if (/^\d+\.\s*\(/.test(ansLine)) break;
              if (/^[一二三四五六七八九十]+[\.、]/.test(ansLine) && /题/.test(ansLine)) break;
              if (/^[A-D]\.\s/.test(ansLine)) break;
              if (ansLine.startsWith("我的答案")) break;
              if (ansLine.length > 0 && !ansLine.startsWith("(") && ansLine.length < 200) {
                entry.answerTexts.push(ansLine);
                if (!entry.answer) entry.answer = ansLine;
              }
              i++;
            }
            continue;
          }

          // Check for "我的答案：" (Chinese colon) followed by multi-line answers
          if (trimmed.startsWith("我的答案：")) {
            const ans = trimmed.replace("我的答案：", "").trim();
            if (ans) entry.answerTexts.push(ans);
            if (!entry.answer && ans) entry.answer = ans;
            i++;

            // Read multi-line answers
            while (i < lines.length) {
              const ansLine = lines[i].trim();
              if (/^\d+\.\s*\(/.test(ansLine)) break;
              if (/^[一二三四五六七八九十]+[\.、]/.test(ansLine) && /题/.test(ansLine)) break;
              if (/^[A-D]\.\s/.test(ansLine)) break;
              if (ansLine.startsWith("(") && /^\s*$/.test(ansLine)) { i++; continue; }
              if (ansLine.length > 0 && ansLine.length < 500) {
                entry.answerTexts.push(ansLine);
                if (!entry.answer) entry.answer = ansLine;
              }
              i++;
            }
            continue;
          }

          // If current line is not empty and not matched as option/section,
          // append to the question text (for multi-line questions)
          if (trimmed && !/^\d+\.\s*\(/.test(trimmed) && !/^[一二三四五六七八九十]+[\.、]/.test(trimmed)) {
            if (entry.options.length === 0 && !trimmed.startsWith("我的答案")) {
              entry.text += " " + cleanQuestionText(trimmed);
            }
          }

          i++;
        }

        // Combine multi-line answers
        if (entry.answerTexts.length > 1) {
          entry.answer = entry.answerTexts.join("；");
        }

        // Classify question type
        if (entry.rawType.includes("判断")) {
          entry.type = "judgment";
        } else if (entry.rawType.includes("填空") || entry.rawType.includes("简答") || entry.rawType.includes("综合")) {
          entry.type = "fill-blank";
        } else if (entry.rawType.includes("多选")) {
          entry.type = "multi-select";
        } else {
          entry.type = "single-select";
        }

        // Normalize judgment answers
        if (entry.type === "judgment") {
          entry.answer = entry.answer.includes("对") ? "对" : "错";
        }

        // For single-select, extract just the letter
        if (entry.type === "single-select" && entry.options.length > 0) {
          const letterMatch = entry.answer.match(/^([A-D])/);
          if (letterMatch) {
            entry.answer = letterMatch[1];
          }
        }

        entries.push(entry);
        continue;
      }

      i++;
    }

    return entries;
  }

  /**
   * Clean question text: remove numbering prefixes, normalize whitespace.
   */
  function cleanQuestionText(text) {
    return text
      .replace(/^[\d]+[\.\、\）\)\s]+/, "")
      .replace(/\s+/g, "")
      .replace(/[（(]\s*[）)]/g, "")  // remove (        ) placeholders
      .replace(/_{2,}/g, "")           // remove ______ fill blanks
      .trim();
  }

  /**
   * Calculate character-level similarity between two Chinese strings.
   * Returns a value between 0 and 1.
   */
  function charSimilarity(a, b) {
    if (!a || !b) return 0;

    // Use character bigrams for matching
    const getBigrams = (s) => {
      const bigrams = new Set();
      for (let i = 0; i < s.length - 1; i++) {
        bigrams.add(s.substring(i, i + 2));
      }
      return bigrams;
    };

    const aBigrams = getBigrams(a);
    const bBigrams = getBigrams(b);
    if (aBigrams.size === 0 && bBigrams.size === 0) return 0;

    let intersection = 0;
    for (const bg of aBigrams) {
      if (bBigrams.has(bg)) intersection++;
    }

    const union = aBigrams.size + bBigrams.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Search the question bank for a matching question.
   * Returns { answer, entry, similarity } or null if no match found.
   */
  function searchQuestionBank(queryText) {
    if (!questionBankLoaded || questionBank.length === 0) return null;

    const cleanQuery = cleanQuestionText(queryText);

    let bestMatch = null;
    let bestScore = 0;

    for (const entry of questionBank) {
      const score = charSimilarity(cleanQuery, entry.text);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entry;
      }
    }

    if (bestMatch && bestScore >= BANK_MATCH_THRESHOLD) {
      console.log(`[AutoAnswer] Bank match! Score=${bestScore.toFixed(3)}, answer="${bestMatch.answer}"`);
      console.log(`[AutoAnswer] Query:  "${cleanQuery.substring(0, 60)}..."`);
      console.log(`[AutoAnswer] Matched:"${bestMatch.text.substring(0, 60)}..."`);
      return {
        answer: bestMatch.answer,
        entry: bestMatch,
        similarity: bestScore
      };
    }

    if (bestMatch) {
      console.log(`[AutoAnswer] Best bank score=${bestScore.toFixed(3)} < threshold ${BANK_MATCH_THRESHOLD}, falling back to AI.`);
      console.log(`[AutoAnswer] Query:  "${cleanQuery.substring(0, 80)}..."`);
      console.log(`[AutoAnswer] Closest:"${bestMatch.text.substring(0, 80)}..."`);
    }

    return null;
  }

  // Start loading the bank immediately
  loadQuestionBank();

  // ==================== QUESTION DETECTION ====================

  /**
   * Main entry: scan the page for all answerable questions.
   * Returns an array of { element, text, type, options?, inputEl }
   */
  function scanQuestions() {
    const questions = [];
    const processed = new Set(); // Avoid duplicates

    // Strategy 1: Find radio/checkbox groups (选择题/判断题)
    scanChoiceQuestions(questions, processed);

    // Strategy 2: Find text inputs and textareas (填空题)
    scanFillQuestions(questions, processed);

    console.log(`[AutoAnswer] Scan complete. Found ${questions.length} questions total.`);
    questions.forEach((q, i) => {
      const optInfo = q.options.length > 0 ? ` (${q.options.length} options)` : ` (${q.inputElements.length} inputs)`;
      console.log(`[AutoAnswer]   Q${i + 1} [${q.type}]${optInfo}: ${q.text.substring(0, 50)}...`);
    });

    // Diagnostic: dump page structure hints (always, for debugging)
    if (questions.length <= 1) {
      const allRoles = document.querySelectorAll('[role]');
      const roleTypes = {};
      allRoles.forEach(el => {
        const r = el.getAttribute("role");
        roleTypes[r] = (roleTypes[r] || 0) + 1;
      });
      console.log("[AutoAnswer] DIAGNOSTIC — ARIA roles on page:", roleTypes);

      // Check for iframes
      const iframes = document.querySelectorAll("iframe");
      console.log(`[AutoAnswer] DIAGNOSTIC — iframes: ${iframes.length}`);
      iframes.forEach((f, i) => {
        console.log(`[AutoAnswer]   iframe ${i}: src=${f.src?.substring(0, 100)}, id=${f.id}, class=${f.className}`);
      });

      // Check for common Chaoxing class patterns
      const chaoxing = document.querySelectorAll(
        '[class*="mark"], [class*="Mark"], [class*="ZhanDui"], [class*="answer"], [class*="Answer"], [class*="timu"], [class*="question"], [class*="Question"]'
      );
      console.log(`[AutoAnswer] DIAGNOSTIC — Chaoxing-like elements: ${chaoxing.length}`);
      chaoxing.forEach((el, i) => {
        if (i < 5) console.log(`[AutoAnswer]   ${el.tagName}.${el.className?.substring(0, 60)} children=${el.children.length}`);
      });

      // Dump top-level structure
      const body = document.body;
      if (body) {
        const topChildren = Array.from(body.children).slice(0, 15);
        console.log("[AutoAnswer] DIAGNOSTIC — Top body children:");
        topChildren.forEach(el => {
          console.log(`[AutoAnswer]   <${el.tagName.toLowerCase()} id="${el.id}" class="${(el.className || "").toString().substring(0, 50)}" children=${el.children.length}>`);
        });
      }
    }

    return questions;
  }

  /**
   * Scan for radio/checkbox groups → choice questions
   * Supports: native inputs, ARIA roles, Chaoxing/超星 custom components, and generic patterns.
   */
  function scanChoiceQuestions(questions, processed) {
    // ==================== Strategy 1: Chaoxing/超星 specific ====================
    // Use the exact DOM structure: .questionLi > .mark_name + .answerBg > .num_option[data]
    const chaoxingQuestions = document.querySelectorAll('.questionLi');
    console.log(`[AutoAnswer] Chaoxing .questionLi containers: ${chaoxingQuestions.length}`);

    if (chaoxingQuestions.length > 0) {
      chaoxingQuestions.forEach((container) => {
        if (processed.has(getElementIdentifier(container))) return;

        // Get question text from .mark_name, h3, .title, .font14
        const titleEl = container.querySelector('.mark_name, h3, .title, .font14');
        if (!titleEl) return;
        const questionText = titleEl.innerText?.trim() || "";
        if (!questionText || questionText.length < 2) return;

        // Check if this is a choice question (has .answerBg with onclick="addChoice" and .singleoption/.multioption)
        const answerBgs = container.querySelectorAll('.answerBg');
        const choiceOptions = Array.from(answerBgs).filter(bg => {
          const hasOnclick = bg.getAttribute('onclick')?.includes('addChoice');
          const hasClass = bg.classList.contains('singleoption') || bg.classList.contains('multioption');
          const hasNumOption = bg.querySelector('.num_option, .num_option_dx');
          return (hasOnclick || hasClass) && hasNumOption;
        });

        console.log(`[AutoAnswer] Container "${questionText.substring(0, 30)}...": answerBgs=${answerBgs.length}, choiceOptions=${choiceOptions.length}`);

        if (choiceOptions.length >= 2) {
          // This is a choice question
          processed.add(getElementIdentifier(container));
          const options = choiceOptions.map((opt) => {
            const span = opt.querySelector('.num_option, .num_option_dx');
            const letter = span?.getAttribute("data") || "";
            const text = opt.innerText?.trim() || "";
            return { text: text || letter, element: opt, letter: letter };
          });

          const isMulti = container.querySelector('.check_answer_dx, .num_option_dx') !== null ||
            container.className?.toString().includes("multi") ||
            container.getAttribute("typename")?.includes("多选");
          const isTrueFalse = isJudgmentQuestion(questionText, options);

          console.log(`[AutoAnswer] Chaoxing choice: "${questionText.substring(0, 40)}..." options=${options.length}`);
          questions.push({
            element: container,
            text: questionText,
            type: isTrueFalse ? "judgment" : isMulti ? "multi-select" : "single-select",
            options: options,
            inputElements: Array.from(choiceOptions),
          });
        } else {
          // This might be a fill-in-the-blank question — handled by scanFillQuestions
          console.log(`[AutoAnswer] Chaoxing non-choice (will check as fill-blank): "${questionText.substring(0, 40)}..."`);
        }
      });

      // If Chaoxing-specific scan found questions, also try fallback selectors
      if (questions.length === 0) {
        // Try [typename] attribute
        const typenameEls = document.querySelectorAll('[typename]');
        console.log(`[AutoAnswer] Chaoxing [typename] containers: ${typenameEls.length}`);
        typenameEls.forEach((container) => {
          if (processed.has(getElementIdentifier(container))) return;
          processed.add(getElementIdentifier(container));
          const titleEl = container.querySelector('.mark_name, h3, .title, .font14');
          if (!titleEl) return;
          const questionText = titleEl.innerText?.trim() || "";
          if (!questionText || questionText.length < 2) return;
          const optionEls = container.querySelectorAll('.answerBg');
          if (optionEls.length < 2) return;
          const options = Array.from(optionEls).map((opt) => {
            const span = opt.querySelector('.num_option, .num_option_dx');
            const letter = span?.getAttribute("data") || "";
            return { text: opt.innerText?.trim() || letter, element: opt, letter: letter };
          });
          const isMulti = container.querySelector('.check_answer_dx, .num_option_dx') !== null;
          questions.push({
            element: container,
            text: questionText,
            type: isMulti ? "multi-select" : "single-select",
            options: options,
            inputElements: Array.from(optionEls),
          });
        });
      }

      // Try generic: div containing both .mark_name and .answerBg
      if (questions.length === 0) {
        const allDivs = document.querySelectorAll('div');
        allDivs.forEach((div) => {
          if (processed.has(getElementIdentifier(div))) return;
          const titleEl = div.querySelector('.mark_name, h3, .title, .font14');
          const optionEls = div.querySelectorAll('.answerBg');
          if (!titleEl || optionEls.length < 2) return;
          processed.add(getElementIdentifier(div));
          const questionText = titleEl.innerText?.trim() || "";
          if (!questionText || questionText.length < 2) return;
          const options = Array.from(optionEls).map((opt) => {
            const span = opt.querySelector('.num_option, .num_option_dx');
            const letter = span?.getAttribute("data") || "";
            return { text: opt.innerText?.trim() || letter, element: opt, letter: letter };
          });
          const isMulti = div.querySelector('.check_answer_dx, .num_option_dx') !== null;
          questions.push({
            element: div,
            text: questionText,
            type: isMulti ? "multi-select" : "single-select",
            options: options,
            inputElements: Array.from(optionEls),
          });
        });
      }

      if (questions.length > 0) {
        console.log(`[AutoAnswer] Chaoxing strategy found ${questions.length} questions.`);
        return; // Chaoxing-specific scan succeeded, skip generic strategies
      }
    }

    // ==================== Strategy 2: Native <input type="radio/checkbox"> ====================
    const nativeInputs = document.querySelectorAll(
      'input[type="radio"], input[type="checkbox"]'
    );
    console.log(`[AutoAnswer] Native radio/checkbox inputs: ${nativeInputs.length}`);

    const nativeGroups = {};
    let hiddenCount = 0;
    nativeInputs.forEach((input) => {
      if (!isVisible(input)) { hiddenCount++; return; }
      const groupKey = input.name || findContainerKey(input);
      if (!groupKey) return;
      if (!nativeGroups[groupKey]) nativeGroups[groupKey] = [];
      nativeGroups[groupKey].push(input);
    });
    console.log(`[AutoAnswer] Native: ${hiddenCount} hidden, ${Object.keys(nativeGroups).length} groups.`);

    for (const [groupKey, groupInputs] of Object.entries(nativeGroups)) {
      if (groupInputs.length < 2) continue;
      addChoiceQuestion(questions, processed, groupInputs, groupInputs[0].type === "checkbox");
    }

    // ==================== Strategy 3: ARIA role="radio" / "checkbox" / "option" ====================
    const ariaRadios = document.querySelectorAll('[role="radio"], [role="option"]');
    const ariaCheckboxes = document.querySelectorAll('[role="checkbox"]');
    console.log(`[AutoAnswer] ARIA radios/options: ${ariaRadios.length}, ARIA checkboxes: ${ariaCheckboxes.length}`);

    const ariaOptions = [...ariaRadios, ...ariaCheckboxes].filter((el) => {
      if (!isVisible(el)) return false;
      const text = el.textContent?.trim() || "";
      const isUILike = /^(下一题|上一题|提交|确定|取消|返回|退出|画笔|橡皮擦|撤销|恢复|清空|答题卡|当前题目|已作答|未作答)/.test(text);
      const isQuestionNumber = /^\d{1,3}$/.test(text) || /^第?\d{1,3}题?$/.test(text);
      const inSidebar = el.closest('[class*="left"], [class*="sidebar"], [class*="nav"], [class*="card"], [class*="number"], [class*="hao"]');
      return text.length > 0 && text.length < 300 && !isUILike && !isQuestionNumber && !inSidebar;
    });
    console.log(`[AutoAnswer] ARIA options after UI filter: ${ariaOptions.length}`);

    const ariaGroups = {};
    ariaOptions.forEach((el) => {
      const groupEl = el.closest('[role="radiogroup"], [role="group"], [role="listbox"]');
      let groupKey;
      if (groupEl) {
        groupKey = getElementIdentifier(groupEl);
      } else {
        const parent = findOptionGroupParent(el);
        groupKey = parent ? getElementIdentifier(parent) : getElementIdentifier(el.parentElement);
      }
      if (!groupKey) return;
      if (!ariaGroups[groupKey]) ariaGroups[groupKey] = [];
      ariaGroups[groupKey].push(el);
    });
    console.log(`[AutoAnswer] ARIA groups: ${Object.keys(ariaGroups).length}`);

    for (const [groupKey, groupInputs] of Object.entries(ariaGroups)) {
      if (groupInputs.length < 2) continue;
      const isCheckbox = groupInputs[0].getAttribute("role") === "checkbox";
      addChoiceQuestion(questions, processed, groupInputs, isCheckbox);
    }

    // ==================== Strategy 4: Generic heuristic ====================
    scanGenericOptionGroups(questions, processed);
  }

  /**
   * Helper: add a choice question from a group of option elements.
   * Handles both native inputs and custom/ARIA components.
   */
  function addChoiceQuestion(questions, processed, optionEls, isCheckbox) {
    const firstEl = optionEls[0];
    if (processed.has(firstEl)) {
      console.log(`[AutoAnswer] addChoiceQuestion: first element already processed`);
      return;
    }

    let container = findQuestionContainer(firstEl);
    if (!container) {
      console.log(`[AutoAnswer] addChoiceQuestion: no container found for`, firstEl.tagName, firstEl.className?.toString().substring(0, 30));
      return;
    }

    // Try extracting question text; if empty, walk up to parent containers
    let questionText = extractQuestionText(container, optionEls);
    let tries = 0;
    while ((!questionText || questionText.length < 2) && container.parentElement && container.parentElement !== document.body && tries < 3) {
      container = container.parentElement;
      questionText = extractQuestionText(container, optionEls);
      tries++;
    }

    const containerId = getElementIdentifier(container);
    if (processed.has(containerId)) {
      console.log(`[AutoAnswer] addChoiceQuestion: container already processed: ${containerId.substring(0, 50)}`);
      return;
    }
    processed.add(containerId);
    processed.add(firstEl);

    if (!questionText || questionText.length < 2) {
      console.log(`[AutoAnswer] addChoiceQuestion: question text too short after ${tries} parent walks: "${questionText}"`);
      return;
    }

    const options = optionEls.map((el) => ({
      text: getOptionText(el),
      element: el,
    }));

    const isTrueFalse = isJudgmentQuestion(questionText, options);

    console.log(`[AutoAnswer] addChoiceQuestion: added question "${questionText.substring(0, 50)}..." with ${options.length} options`);
    questions.push({
      element: container,
      text: questionText,
      type: isTrueFalse ? "judgment" : isCheckbox ? "multi-select" : "single-select",
      options: options,
      inputElements: optionEls,
    });
  }

  /**
   * Get text from an option element (works for both native and custom components).
   */
  function getOptionText(el) {
    // If it's a native input, try label first
    if (el.tagName === "INPUT") {
      const label = findLabelForInput(el);
      if (label) return label;
    }
    // For ARIA/custom elements, get text content
    const text = el.textContent?.trim() || "";
    if (text && text.length < 300) return text;
    return el.getAttribute("aria-label") || el.getAttribute("title") || el.value || "";
  }

  /**
   * Find the nearest parent that contains multiple option-like children.
   * Walks up the DOM tree looking for a parent with 2+ children that share a similar role or class.
   */
  function findOptionGroupParent(el) {
    let current = el.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 5) {
      const children = Array.from(current.children);
      // Count children with the same tag and role as our element
      const sameRole = children.filter(c =>
        c.getAttribute("role") === el.getAttribute("role") && isVisible(c)
      );
      if (sameRole.length >= 2) return current;
      // Count children with similar class names
      const elClasses = el.className?.toString().split(/\s+/).filter(c => c.length > 2) || [];
      if (elClasses.length > 0) {
        const similar = children.filter(c => {
          const cClasses = c.className?.toString().split(/\s+/) || [];
          return elClasses.some(ec => cClasses.includes(ec)) && isVisible(c);
        });
        if (similar.length >= 2) return current;
      }
      current = current.parentElement;
      depth++;
    }
    return null;
  }

  /**
   * Generic heuristic: find repeated sibling structures that look like options.
   * Looks for parent containers with 2+ similar child elements.
   */
  function scanGenericOptionGroups(questions, processed) {
    // Look for common patterns: ul>li, div>div, .options>li, etc.
    const containers = document.querySelectorAll(
      'ul, ol, [class*="option"], [class*="answer"], [class*="choices"], [class*="select"]'
    );

    containers.forEach((container) => {
      if (processed.has(getElementIdentifier(container))) return;

      // Skip sidebar/navigation containers
      if (container.closest('.marking_left_280, .topicNumber, .topicNumber_list, [class*="sidebar"], [class*="nav"], [class*="card"]')) return;

      // Skip if container is inside a .questionLi that was already processed
      const parentQuestion = container.closest('.questionLi');
      if (parentQuestion && processed.has(getElementIdentifier(parentQuestion))) return;

      const children = Array.from(container.children).filter(
        (c) => c.tagName === "LI" || c.tagName === "DIV" || c.tagName === "SPAN"
      );
      if (children.length < 2 || children.length > 8) return;

      // Check if children have similar structure (same tag, similar classes)
      const tags = new Set(children.map(c => c.tagName));
      if (tags.size > 2) return;

      // Check if they look like options (have text, not too long, not just numbers)
      const validChildren = children.filter(c => {
        const t = c.textContent?.trim();
        if (!t || t.length === 0 || t.length > 200) return false;
        if (!isVisible(c)) return false;
        // Skip if text is just a number (sidebar question numbers)
        if (/^\d{1,3}$/.test(t)) return false;
        return true;
      });
      if (validChildren.length < 2) return;

      // Check if parent question text exists
      const questionContainer = parentQuestion || container.parentElement;
      const titleEl = questionContainer?.querySelector('.mark_name, h3, .title, .font14');
      if (!titleEl) return;

      addChoiceQuestion(questions, processed, validChildren, false);
    });
  }

  /**
   * Scan for text inputs/textareas → fill-in-the-blank questions
   */
  function scanFillQuestions(questions, processed) {
    // Strategy 1: Chaoxing fill-in-the-blank (.questionLi without choice options)
    const chaoxingContainers = document.querySelectorAll('.questionLi');
    console.log(`[AutoAnswer] Scanning ${chaoxingContainers.length} .questionLi for fill-blank`);

    chaoxingContainers.forEach((container) => {
      if (processed.has(getElementIdentifier(container))) return;
      const titleEl = container.querySelector('.mark_name, h3, .title, .font14');
      if (!titleEl) return;

      // Skip if it has choice options (.answerBg with onclick="addChoice")
      const hasChoiceOptions = container.querySelector('.answerBg[onclick*="addChoice"]');
      if (hasChoiceOptions) return;

      const questionText = titleEl.innerText?.trim() || "";
      if (!questionText || questionText.length < 2) return;

      // Look for UEditor iframe (Chaoxing uses this for fill-in-the-blank)
      const ueditorIframe = container.querySelector('iframe[id*="ueditor"], iframe.edui-default');
      if (ueditorIframe) {
        console.log(`[AutoAnswer] Fill-blank UEditor found: "${questionText.substring(0, 30)}..."`);
        processed.add(getElementIdentifier(container));
        questions.push({
          element: container,
          text: questionText,
          type: "fill-blank",
          options: [],
          inputElements: [ueditorIframe], // Store iframe reference
          isUEditor: true
        });
        return;
      }

      // Look for regular inputs
      let inputs = container.querySelectorAll('input[type="text"], textarea, [contenteditable="true"]');
      if (inputs.length === 0) {
        inputs = container.querySelectorAll('input:not([type])');
      }
      if (inputs.length === 0) {
        const stem = container.querySelector('.stem_answer, .answer_area');
        if (stem) inputs = stem.querySelectorAll('input, textarea, [contenteditable="true"]');
      }

      if (inputs.length === 0) {
        console.log(`[AutoAnswer] Fill-blank: no inputs in "${questionText.substring(0, 30)}..."`);
        return;
      }

      const visibleInputs = Array.from(inputs).filter(el => isVisible(el) || el.type === 'hidden');
      if (visibleInputs.length === 0) return;

      processed.add(getElementIdentifier(container));
      console.log(`[AutoAnswer] Fill-blank found: "${questionText.substring(0, 30)}..." inputs=${visibleInputs.length}`);
      questions.push({
        element: container,
        text: questionText,
        type: "fill-blank",
        options: [],
        inputElements: visibleInputs,
      });
    });

    // Strategy 2: Find UEditor iframes directly (for fill-blank not inside .questionLi)
    const ueditorIframes = document.querySelectorAll('iframe[id*="ueditor"]');
    console.log(`[AutoAnswer] UEditor iframes found: ${ueditorIframes.length}`);
    ueditorIframes.forEach(iframe => {
      const container = iframe.closest('.questionLi') || iframe.parentElement;
      if (!container || processed.has(getElementIdentifier(container))) return;

      const titleEl = container.querySelector('.mark_name, h3, .title, .font14');
      if (!titleEl) return;
      const questionText = titleEl.innerText?.trim() || "";
      if (!questionText || questionText.length < 2) return;

      processed.add(getElementIdentifier(container));
      console.log(`[AutoAnswer] UEditor fill-blank: "${questionText.substring(0, 30)}..."`);
      questions.push({
        element: container,
        text: questionText,
        type: "fill-blank",
        options: [],
        inputElements: [iframe],
        isUEditor: true
      });
    });

    // Strategy 3: Generic text inputs
    const inputs = document.querySelectorAll('input[type="text"], input:not([type]), textarea');
    inputs.forEach((input) => {
      if (!isVisible(input) || input.readOnly || input.disabled) return;
      if (input.closest('.questionLi')) return;
      if (isNonQuestionInput(input)) return;

      const container = findQuestionContainer(input);
      if (!container) return;
      const containerId = getElementIdentifier(container);
      if (processed.has(containerId)) return;
      processed.add(containerId);

      const questionText = extractQuestionText(container, [input]);
      if (!questionText || questionText.length < 2) return;
      if (isPersonalField(input, questionText)) return;

      questions.push({
        element: container,
        text: questionText,
        type: "fill-blank",
        options: [],
        inputElements: [input],
      });
    });
  }

  // ==================== DOM HELPERS ====================

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.opacity === "0") return false;
    // offsetParent is null for display:none, body/html, and position:fixed elements.
    // Check computed position to catch CSS-class-based fixed positioning.
    if (!el.offsetParent && style.position !== "fixed") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function getElementIdentifier(el) {
    // Create a unique identifier for an element
    if (el.id) return `#${el.id}`;
    const path = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.className && typeof current.className === "string") {
        const classes = current.className.trim().split(/\s+/).slice(0, 2).join(".");
        if (classes) selector += "." + classes;
      }
      path.unshift(selector);
      current = current.parentElement;
    }
    return path.join(" > ");
  }

  /**
   * Find the container that holds a question.
   * Walks up the DOM tree looking for common question container patterns.
   */
  function findQuestionContainer(inputEl) {
    const QUESTION_SELECTORS = [
      '[class*="question"]',
      '[class*="problem"]',
      '[class*="topic"]',
      '[class*="item"]',
      '[class*="quiz"]',
      '[class*="exam"]',
      '[class*="test"]',
      '[class*="exercise"]',
      '[class*="ti"]',
      '[class*="timu"]',
      '[class*="mark"]',
      '[class*="Mark"]',
      '[class*="ZhanDui"]',
      '[class*="zhuanti"]',
      '[class*="singleQ"]',
      '[class*="multiQ"]',
      '[class*="judgeQ"]',
      '[class*="fillQ"]',
      '[class*="answer"]',
      '[class*="option"]',
      '[id*="question"]',
      '[id*="problem"]',
      '[id*="topic"]',
      "fieldset",
      "li",
      "tr",
      ".card",
      ".panel",
      ".section",
    ];

    let current = inputEl.parentElement;
    let bestMatch = null;
    let depth = 0;
    const MAX_DEPTH = 10;

    while (current && current !== document.body && depth < MAX_DEPTH) {
      // Check if this element matches any question selector
      for (const selector of QUESTION_SELECTORS) {
        try {
          if (current.matches(selector)) {
            bestMatch = current;
            break;
          }
        } catch (e) {
          // Invalid selector, skip
        }
      }

      // Also check if this container has meaningful text content
      const text = current.textContent?.trim() || "";
      if (text.length > 10 && text.length < 2000) {
        // If we haven't found a selector match yet, use this as fallback
        if (!bestMatch) {
          bestMatch = current;
        }
      }

      // Stop if we hit a form or a large container
      if (current.tagName === "BODY") break;
      if (current.tagName === "FORM") {
        // Use form as container only if we have no better match
        if (!bestMatch) bestMatch = current;
        break;
      }
      // Large container: stop climbing but keep current bestMatch
      if (current.scrollHeight > 3000) break;

      current = current.parentElement;
      depth++;
    }

    return bestMatch;
  }

  function findContainerKey(inputEl) {
    // Try to find a grouping key for inputs
    if (inputEl.name) return inputEl.name;
    if (inputEl.form) {
      // Use form + position as key
      const formInputs = inputEl.form.querySelectorAll(
        'input[type="radio"], input[type="checkbox"]'
      );
      const index = Array.from(formInputs).indexOf(inputEl);
      return `form-${getElementIdentifier(inputEl.form)}-group-${index}`;
    }
    return null;
  }

  /**
   * Extract question text from a container, excluding option labels.
   */
  function extractQuestionText(container, optionElements) {
    // Clone container to avoid modifying the page
    const clone = container.cloneNode(true);

    // Remove input elements and their labels from the clone
    clone
      .querySelectorAll('input[type="radio"], input[type="checkbox"], input[type="text"], textarea')
      .forEach((el) => el.remove());

    // Remove labels that wrap inputs
    clone.querySelectorAll("label").forEach((el) => {
      if (el.querySelector("input")) el.remove();
    });

    // Remove custom option elements (ARIA roles, li items, etc.)
    clone
      .querySelectorAll('[role="radio"], [role="checkbox"], [role="option"]')
      .forEach((el) => el.remove());

    // Remove common non-question elements
    clone
      .querySelectorAll("script, style, button, nav, footer, header")
      .forEach((el) => el.remove());

    // Remove UI elements common in Chaoxing/learning platforms
    const uiSelectors = [
      '[class*="toolbar"]', '[class*="tool"]', '[class*="nav"]',
      '[class*="menu"]', '[class*="btn"]', '[class*="button"]',
      '[class*="prev"]', '[class*="next"]', '[class*="submit"]',
      '[class*="card"]', '[class*="answer-card"]', '[class*="progress"]',
      '[class*="timer"]', '[class*="countdown"]',
      // Chaoxing specific UI
      '[class*="paint"]', '[class*="eraser"]', '[class*="undo"]',
      '[class*="redo"]', '[class*="clear"]', '[class*="exit"]',
    ];
    uiSelectors.forEach(sel => {
      try { clone.querySelectorAll(sel).forEach(el => el.remove()); } catch(e) {}
    });

    let text = clone.textContent || "";

    // Clean up whitespace
    text = text.replace(/\s+/g, " ").trim();

    // If text is too long (container too large), try to extract just the first question-like sentence
    if (text.length > 200) {
      // Try to find a sentence that looks like a question (ends with ？? or has question keywords)
      const questionMatch = text.match(/([一-龥\w]{5,}[？\?]?)/);
      if (questionMatch && questionMatch[1].length < 200) {
        text = questionMatch[1].trim();
      } else {
        // Just take the first 150 chars
        text = text.substring(0, 150).trim();
      }
    }

    // Remove common prefixes like "1.", "1、", "（1）", "第1题"
    text = text.replace(/^[\d]+[\.\、\)\）\s]+/, "");
    text = text.replace(/^第[\d]+题[\.\、\s]*/, "");
    text = text.replace(/^[\(（][\d]+[\)）]\s*/, "");

    // Remove trailing UI text that might remain
    text = text.replace(/\s*(下一题|上一题|提交|确定|取消|返回|退出|画笔|橡皮擦|撤销|恢复|清空|答题卡|当前题目|已作答|未作答).*$/, "");

    return text;
  }

  /**
   * Find the label text for an input element.
   */
  function findLabelForInput(input) {
    // Method 1: <label for="id">
    if (input.id) {
      const label = document.querySelector(`label[for="${input.id}"]`);
      if (label) return label.textContent.trim();
    }

    // Method 2: Parent <label>
    const parentLabel = input.closest("label");
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll("input").forEach((el) => el.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }

    // Method 3: Next sibling text
    let sibling = input.nextSibling;
    while (sibling) {
      if (sibling.nodeType === Node.TEXT_NODE) {
        const text = sibling.textContent.trim();
        if (text) return text;
      }
      if (sibling.nodeType === Node.ELEMENT_NODE) {
        const text = sibling.textContent.trim();
        if (text && text.length < 200) return text;
      }
      sibling = sibling.nextSibling;
    }

    // Method 4: Parent's text content
    const parentText = input.parentElement?.textContent?.trim();
    if (parentText && parentText.length < 200) {
      return parentText;
    }

    return input.value || "";
  }

  function isJudgmentQuestion(text, options) {
    // Check if options are 对/错, 是/否, 正确/错误, T/F, etc.
    if (options.length !== 2) return false;
    const optTexts = options.map((o) => o.text.toLowerCase().trim());
    const judgmentPairs = [
      ["对", "错"],
      ["是", "否"],
      ["正确", "错误"],
      ["true", "false"],
      ["√", "×"],
      ["yes", "no"],
      ["right", "wrong"],
    ];
    for (const pair of judgmentPairs) {
      if (
        (optTexts[0].includes(pair[0]) && optTexts[1].includes(pair[1])) ||
        (optTexts[0].includes(pair[1]) && optTexts[1].includes(pair[0]))
      ) {
        return true;
      }
    }
    return false;
  }

  function isNonQuestionInput(input) {
    const name = (input.name || "").toLowerCase();
    const id = (input.id || "").toLowerCase();
    const placeholder = (input.placeholder || "").toLowerCase();
    const autocomplete = (input.autocomplete || "").toLowerCase();

    const nonQuestionPatterns = [
      "search",
      "query",
      "q",
      "login",
      "user",
      "email",
      "phone",
      "tel",
      "address",
      "zip",
      "postal",
      "captcha",
      "verify",
      "password",
      "pwd",
      "username",
      "account",
      "nickname",
      "comment",
      "reply",
      "message",
      "chat",
      "url",
      "link",
      "website",
    ];

    const allFields = `${name} ${id} ${placeholder} ${autocomplete}`;
    return nonQuestionPatterns.some((p) => allFields.includes(p));
  }

  function isPersonalField(input, questionText) {
    const combined = `${input.name || ""} ${input.id || ""} ${input.placeholder || ""} ${questionText}`.toLowerCase();
    const personalPatterns = [
      "姓名",
      "名字",
      "name",
      "学号",
      "工号",
      "员工",
      "手机",
      "电话",
      "phone",
      "邮箱",
      "email",
      "部门",
      "department",
      "班级",
      "class",
    ];
    return personalPatterns.some((p) => combined.includes(p));
  }

  // ==================== AI COMMUNICATION ====================

  /**
   * Build the prompt for a batch of questions.
   */
  function buildPrompt(questions) {
    let prompt = "请回答以下题目，每道题只返回答案，用 JSON 数组格式返回。\n\n";
    prompt += "返回格式示例：\n";
    prompt += '[{"id": 1, "answer": "A"}, {"id": 2, "answer": "对"}, {"id": 3, "answer": "完整答案文本"}]\n\n';
    prompt += "注意：\n";
    prompt += "- 选择题只返回选项字母（A/B/C/D）\n";
    prompt += "- 判断题只返回「对」或「错」\n";
    prompt += "- 填空题和简答题返回完整答案，不要省略\n\n";
    prompt += "题目列表：\n\n";

    questions.forEach((q, index) => {
      prompt += `【第 ${index + 1} 题】`;
      if (q.type === "single-select") {
        prompt += `[单选题] `;
      } else if (q.type === "multi-select") {
        prompt += `[多选题] `;
      } else if (q.type === "judgment") {
        prompt += `[判断题] `;
      } else {
        prompt += `[填空题] `;
      }
      prompt += q.text + "\n";

      if (q.options && q.options.length > 0) {
        q.options.forEach((opt, i) => {
          const letter = String.fromCharCode(65 + i); // A, B, C, D...
          prompt += `  ${letter}. ${opt.text}\n`;
        });
      }
      prompt += "\n";
    });

    return prompt;
  }

  function buildWordPrompt(question) {
    let prompt = "请回答下面这道题，只返回最终答案，不要解释，不要句子，不要 JSON。\n";
    prompt += "如果是填空，只返回应填内容；多个空用 # 分隔。\n";
    prompt += "尽量精简，多个空用 # 分隔。\n\n";
    prompt += `[题型] ${question.type}\n`;
    prompt += `[题目] ${question.text}\n`;
    if (question.options && question.options.length > 0) {
      prompt += "选项：\n";
      question.options.forEach((opt, i) => {
        prompt += `${String.fromCharCode(65 + i)}. ${opt.text}\n`;
      });
    }
    return prompt;
  }

  /**
   * Send questions to AI via the background script and get answers.
   */
  async function requestAnswers(questions) {
    const prompt = buildPrompt(questions);

    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: "ai-auto-answer" });
      let settled = false;

      const safeResolve = (val) => { if (!settled) { settled = true; resolve(val); } };
      const safeReject = (err) => { if (!settled) { settled = true; reject(err); } };

      port.postMessage({
        action: "REQUEST_AI",
        text: prompt,
      });

      let fullResponse = "";

      port.onMessage.addListener((msg) => {
        if (msg.action === "chunk") {
          fullResponse += msg.text;
        } else if (msg.action === "done") {
          port.disconnect();
          safeResolve(parseAnswers(fullResponse, questions));
        } else if (msg.action === "error") {
          port.disconnect();
          safeReject(new Error(msg.error));
        }
      });

      port.onDisconnect.addListener(() => {
        if (fullResponse) {
          safeResolve(parseAnswers(fullResponse, questions));
        } else {
          safeReject(new Error("连接已断开"));
        }
      });

      // Timeout after 60 seconds
      setTimeout(() => {
        port.disconnect();
        safeReject(new Error("AI 请求超时"));
      }, 60000);
    });
  }

  async function requestWordAnswer(question) {
    const prompt = buildWordPrompt(question);
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: "ai-auto-answer" });
      let fullResponse = "";
      let settled = false;
      const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };
      port.postMessage({ action: "REQUEST_AI", text: prompt });
      port.onMessage.addListener((msg) => {
        if (msg.action === "chunk") fullResponse += msg.text || "";
        else if (msg.action === "done") {
          try { port.disconnect(); } catch (_) {}
          done(resolve, fullResponse.trim());
        } else if (msg.action === "error") {
          try { port.disconnect(); } catch (_) {}
          done(reject, new Error(msg.error));
        }
      });
      port.onDisconnect.addListener(() => {
        if (fullResponse.trim()) done(resolve, fullResponse.trim());
      });
      setTimeout(() => {
        try { port.disconnect(); } catch (_) {}
        done(reject, new Error("AI 请求超时"));
      }, 60000);
    });
  }

  /**
   * Parse AI response to extract answers.
   */
  function parseAnswers(response, questions) {
    const answers = [];

    // Try to parse as JSON first
    try {
      // Find JSON array in the response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        parsed.forEach((item, index) => {
          if (item.answer !== undefined) {
            answers.push({
              index: index,
              answer: String(item.answer).trim(),
            });
          }
        });
        return answers;
      }
    } catch (e) {
      console.warn("[AutoAnswer] Failed to parse JSON response, trying fallback.", e);
    }

    // Fallback: parse line by line
    const lines = response.split("\n").filter((l) => l.trim());
    lines.forEach((line, index) => {
      // Try patterns like "1. A", "第1题: A", "1、A", etc.
      const match = line.match(/(?:第?\s*(\d+)\s*[题\.\、\:\)）]?\s*)?([A-Da-d]{1,4}|对|错|正确|错误|√|×)/);
      if (match && index < questions.length) {
        answers.push({
          index: index,
          answer: (match[2] || match[0]).trim(),
        });
      }
    });

    return answers;
  }

  // ==================== AUTO-FILL ====================

  /**
   * Fill in the answer for a question.
   */
  function fillAnswer(question, answer) {
    const answerText = answer.trim();
    console.log(`[AutoAnswer] Filling [${question.type}]: "${answerText}" for "${question.text.substring(0, 40)}..."`);

    switch (question.type) {
      case "single-select":
      case "judgment":
        fillChoiceAnswer(question, answerText.toUpperCase());
        break;
      case "multi-select":
        fillMultiChoiceAnswer(question, answerText.toUpperCase());
        break;
      case "fill-blank":
        fillBlankAnswer(question, answerText);
        break;
    }

    // Highlight the filled question
    highlightQuestion(question.element);
  }

  function fillChoiceAnswer(question, answerText) {
    let targetIndex = -1;

    const letterMatch = answerText.match(/^([A-D])/);
    if (letterMatch) targetIndex = letterMatch[1].charCodeAt(0) - 65;

    const numMatch = answerText.match(/^(\d)/);
    if (numMatch) targetIndex = parseInt(numMatch[1]) - 1;

    if (question.type === "judgment") {
      const isCorrect =
        answerText.includes("对") || answerText.includes("正确") ||
        answerText === "TRUE" || answerText === "T" || answerText === "YES" ||
        answerText === "Y" || answerText.includes("√");
      targetIndex = isCorrect ? 0 : 1;
    }

    if (targetIndex < 0 || targetIndex >= question.options.length) return;

    // First: unselect any currently selected option that is NOT the target
    question.options.forEach((opt, idx) => {
      if (idx !== targetIndex && isOptionSelected(opt.element)) {
        unselectOption(opt.element);
      }
    });

    // Then: select the target
    selectOption(question.options[targetIndex].element, question.options[targetIndex].letter);
  }

  function fillMultiChoiceAnswer(question, answerText) {
    const letters = answerText.match(/[A-D]/g) || [];
    const targetIndices = letters.map((l) => l.charCodeAt(0) - 65);

    // Unselect options that shouldn't be selected, select those that should
    question.options.forEach((opt, idx) => {
      const shouldBeSelected = targetIndices.includes(idx);
      const isSelected = isOptionSelected(opt.element);
      if (isSelected && !shouldBeSelected) {
        unselectOption(opt.element);
      } else if (!isSelected && shouldBeSelected) {
        selectOption(opt.element, opt.letter);
      }
    });
  }

  /**
   * Unselect an option element (click to toggle off).
   */
  function unselectOption(el) {
    if (!isOptionSelected(el)) return;
    console.log(`[AutoAnswer] Unselecting: ${el.textContent?.substring(0, 10)}`);

    if (el.tagName === "INPUT") {
      el.checked = false;
      triggerChange(el);
    } else if (el.classList?.contains('answerBg') || el.querySelector?.('.num_option, .num_option_dx')) {
      // Chaoxing: click to toggle off
      el.click();
      triggerChange(el);
    } else {
      el.click();
      if (el.getAttribute("role") === "checkbox") {
        el.setAttribute("aria-checked", "false");
      }
      triggerChange(el);
    }
  }

  /**
   * Check if an option element is currently selected.
   */
  function isOptionSelected(el) {
    // Chaoxing: .check_answer or .check_answer_dx class
    if (el.classList?.contains('check_answer') || el.classList?.contains('check_answer_dx')) return true;
    // Native input
    if (el.tagName === "INPUT") return el.checked;
    // ARIA
    if (el.getAttribute("aria-checked") === "true") return true;
    return false;
  }

  /**
   * Select an option element — works for both native inputs and custom/ARIA components.
   * Skips if already selected to avoid toggling off.
   * @param {Element} el - The option element to select
   * @param {string} [letter] - The option letter (A/B/C/D) for Chaoxing .num_option[data]
   */
  function selectOption(el, letter) {
    if (el.tagName === "INPUT") {
      // Native input: set checked and trigger events
      el.checked = true;
      triggerChange(el);
    } else if (el.classList?.contains('answerBg') || el.querySelector?.('.num_option, .num_option_dx')) {
      // Chaoxing .answerBg: click to select
      el.click();
      triggerChange(el);
    } else {
      // Custom/ARIA component: simulate click
      el.click();
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // Set ARIA state
      if (el.getAttribute("role") === "radio" || el.getAttribute("role") === "option") {
        el.setAttribute("aria-checked", "true");
        const parent = el.parentElement;
        if (parent) {
          parent.querySelectorAll('[role="radio"], [role="option"]').forEach((sibling) => {
            if (sibling !== el) sibling.setAttribute("aria-checked", "false");
          });
        }
      }
      if (el.getAttribute("role") === "checkbox") {
        el.setAttribute("aria-checked", "true");
      }
      triggerChange(el);
    }
  }

  function fillBlankAnswer(question, answerText) {
    if (question.inputElements.length === 0) return;

    // For multiple blanks, split by common separators; for single blank, use full answer
    let answers;
    if (question.inputElements.length > 1) {
      answers = answerText.split(/[#|;；\n]/).map(s => s.trim()).filter(s => s.length > 0);
    } else {
      answers = [answerText];
    }

    question.inputElements.forEach((input, idx) => {
      const text = answers[idx] || answers[0] || answerText;

      if (question.isUEditor && input.tagName === "IFRAME") {
        setUEditorContent(input, text);
      } else {
        setInputElementValue(input, text);
      }
    });
  }

  /**
   * Set content in a UEditor iframe.
   */
  function setUEditorContent(iframe, value) {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) {
        console.log("[AutoAnswer] Cannot access UEditor iframe document");
        return;
      }

      const body = iframeDoc.body;
      if (!body) {
        console.log("[AutoAnswer] UEditor iframe has no body");
        return;
      }

      // Escape HTML special characters and preserve line breaks
      const escaped = value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '</p><p>');

      // Set content
      body.innerHTML = `<p>${escaped}</p>`;

      // Trigger events
      body.dispatchEvent(new Event("input", { bubbles: true }));
      body.dispatchEvent(new Event("change", { bubbles: true }));
      iframe.dispatchEvent(new Event("change", { bubbles: true }));

      console.log(`[AutoAnswer] UEditor content set (${value.length} chars): "${value.substring(0, 50)}..."`);
    } catch (e) {
      console.error("[AutoAnswer] UEditor set error:", e);
      // Fallback: try using UEditor API
      try {
        const editorId = iframe.id;
        if (editorId && typeof UE !== 'undefined' && UE.getEditor) {
          const editor = UE.getEditor(editorId);
          if (editor) {
            const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            editor.setContent(`<p>${escaped}</p>`);
            console.log(`[AutoAnswer] UEditor API content set (${value.length} chars)`);
          }
        }
      } catch (e2) {
        console.error("[AutoAnswer] UEditor API error:", e2);
      }
    }
  }

  /**
   * Set value on an input element (supports input, textarea, contenteditable).
   */
  function setInputElementValue(el, value) {
    if (el.getAttribute("contenteditable") === "true") {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    } else if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

      if (setter) {
        setter.call(el, value);
      } else {
        el.value = value;
      }
      triggerChange(el);
    } else {
      el.textContent = value;
      triggerChange(el);
    }
  }

  function triggerChange(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function highlightQuestion(element) {
    element.style.transition = "outline 0.3s ease";
    element.style.outline = "2px solid #10b981";
    element.style.outlineOffset = "2px";
    setTimeout(() => {
      element.style.outline = "none";
    }, 3000);
  }

  // ==================== PROGRESS UI ====================

  function createProgressPanel() {
    if (progressPanel) {
      progressPanel.remove();
    }

    const host = document.createElement("div");
    host.id = "auto-answer-host";
    host.style.cssText =
      "position:fixed;top:20px;right:20px;z-index:2147483647;font-family:system-ui,-apple-system,sans-serif;";
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: "open" });

    // Load styles
    const style = document.createElement("style");
    style.textContent = getProgressStyles();
    shadowRoot.appendChild(style);

    // Create panel
    progressPanel = document.createElement("div");
    progressPanel.className = "aa-panel";
    progressPanel.innerHTML = `
      <div class="aa-header">
        <span class="aa-title">🚀 自动答题中</span>
        <div class="aa-header-btns">
          <button class="aa-copy" title="复制状态和答案">复制</button>
          <button class="aa-minimize" title="最小化">─</button>
          <button class="aa-close" title="停止">✕</button>
        </div>
      </div>
      <div class="aa-body">
        <div class="aa-status">正在扫描题目...</div>
        <div class="aa-progress-bar">
          <div class="aa-progress-fill"></div>
        </div>
        <div class="aa-stats">0 / 0 题</div>
        <div class="aa-log"></div>
      </div>
    `;
    shadowRoot.appendChild(progressPanel);

    // Create minimized floating button (shown by default, panel hidden)
    const miniBtn = document.createElement("div");
    miniBtn.className = "aa-mini-btn";
    miniBtn.innerHTML = ``;
    miniBtn.style.display = "flex";
    shadowRoot.appendChild(miniBtn);

    // Minimize button
    shadowRoot.querySelector(".aa-copy").addEventListener("click", async () => {
      const statusText = shadowRoot.querySelector(".aa-status")?.textContent || "";
      const logText = Array.from(shadowRoot.querySelectorAll(".aa-log-entry")).map(el => el.textContent || "").join("\n");
      const text = [statusText, logText].filter(Boolean).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        const btn = shadowRoot.querySelector(".aa-copy");
        const old = btn.textContent;
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = old; }, 1200);
      } catch (e) {
        console.warn("[AutoAnswer] copy failed", e);
      }
    });

    // Minimize button
    shadowRoot.querySelector(".aa-minimize").addEventListener("click", () => {
      progressPanel.style.display = "none";
      miniBtn.style.display = "flex";
      chrome.storage.local.set({ autoAnswerMinimized: true });
    });

    // Expand from minimized
    miniBtn.addEventListener("click", () => {
      progressPanel.style.display = "";
      miniBtn.style.display = "none";
      chrome.storage.local.set({ autoAnswerMinimized: false });
    });

    // Close button
    shadowRoot.querySelector(".aa-close").addEventListener("click", () => {
      stopAutoAnswer();
    });

    // Default: panel hidden, mini button visible
    // Restore from storage if user previously expanded the panel
    chrome.storage.local.get({ autoAnswerMinimized: true }, (result) => {
      if (result.autoAnswerMinimized) {
        progressPanel.style.display = "none";
        miniBtn.style.display = "flex";
      } else {
        // User previously expanded it, restore expanded state
        progressPanel.style.display = "";
        miniBtn.style.display = "none";
      }
    });

    return shadowRoot;
  }

  function updateProgress(current, total, status, logEntry) {
    if (!shadowRoot) return;

    const statusEl = shadowRoot.querySelector(".aa-status");
    const fillEl = shadowRoot.querySelector(".aa-progress-fill");
    const statsEl = shadowRoot.querySelector(".aa-stats");
    const logEl = shadowRoot.querySelector(".aa-log");
    if (statusEl && status) statusEl.textContent = status;
    if (statsEl) statsEl.textContent = `${current} / ${total} 题`;
    if (fillEl) fillEl.style.width = total > 0 ? `${(current / total) * 100}%` : "0%";

    if (logEntry && logEl) {
      const entry = document.createElement("div");
      entry.className = "aa-log-entry";
      entry.textContent = logEntry;
      logEl.appendChild(entry);
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function showResult(total, success, failed) {
    if (!shadowRoot) return;

    const miniBtn = shadowRoot.querySelector(".aa-mini-btn");
    const panel = shadowRoot.querySelector(".aa-panel");

    // Show mini button with done state
    if (miniBtn) {
      miniBtn.style.display = "flex";
      miniBtn.classList.add("aa-mini-done");
    }

    // Hide panel, stay minimized
    if (panel) panel.style.display = "none";
    chrome.storage.local.set({ autoAnswerMinimized: true });

    // Auto-hide after 10 seconds
    setTimeout(() => {
      if (miniBtn) miniBtn.style.display = "none";
    }, 10000);
  }

  function getProgressStyles() {
    return `
      .aa-panel {
        width: 320px;
        background: rgba(255,255,255,0.92);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.12);
        border: 1px solid rgba(255,255,255,0.3);
        overflow: hidden;
        font-size: 14px;
        color: #1f2937;
        animation: aaSlideIn 0.3s ease;
        transition: opacity 0.3s ease;
      }
      .aa-panel:hover {
        background: rgba(255,255,255,0.98);
      }
      @keyframes aaSlideIn {
        from { opacity: 0; transform: translateX(20px); }
        to { opacity: 1; transform: translateX(0); }
      }
      .aa-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: linear-gradient(135deg, rgba(99,102,241,0.85), rgba(139,92,246,0.85));
        backdrop-filter: blur(8px);
        color: #fff;
      }
      .aa-title { font-weight: 600; font-size: 15px; text-shadow: 0 1px 2px rgba(0,0,0,0.1); }
      .aa-header-btns { display: flex; gap: 4px; }
      .aa-copy, .aa-minimize, .aa-close {
        background: none;
        border: none;
        color: #fff;
        font-size: 12px;
        cursor: pointer;
        padding: 2px 8px;
        border-radius: 4px;
        opacity: 0.8;
        line-height: 1;
        transition: all 0.2s ease;
      }
      .aa-minimize, .aa-close { font-size: 16px; }
      .aa-copy:hover, .aa-minimize:hover, .aa-close:hover { opacity: 1; background: rgba(255,255,255,0.25); }
      .aa-body {
        padding: 16px;
        user-select: text !important;
        -webkit-user-select: text !important;
      }
      .aa-status {
        margin-bottom: 12px;
        font-weight: 500;
        user-select: text !important;
        -webkit-user-select: text !important;
        cursor: text;
      }
      .aa-progress-bar {
        height: 6px;
        background: rgba(229,231,235,0.6);
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 8px;
      }
      .aa-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #6366f1, #8b5cf6);
        border-radius: 3px;
        transition: width 0.3s ease;
        width: 0%;
      }
      .aa-stats {
        font-size: 12px;
        color: #6b7280;
        margin-bottom: 12px;
      }
      .aa-log {
        max-height: 150px;
        overflow-y: auto;
        font-size: 12px;
        color: #4b5563;
        border-top: 1px solid rgba(243,244,246,0.6);
        padding-top: 8px;
        user-select: text !important;
        -webkit-user-select: text !important;
        cursor: text;
      }
      .aa-log-entry {
        padding: 3px 0;
        border-bottom: 1px solid rgba(249,250,251,0.5);
        user-select: text !important;
        -webkit-user-select: text !important;
        cursor: text;
      }
      .aa-log-entry:last-child { border-bottom: none; }

      /* Minimized floating button - small subtle dot */
      .aa-mini-btn {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: rgba(255,255,255,0.2);
        cursor: pointer;
        box-shadow: none;
        border: none;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        transition: all 0.4s ease;
        opacity: 0.3;
      }
      .aa-mini-btn:hover {
        opacity: 0.8;
        background: rgba(255,255,255,0.6);
        box-shadow: 0 0 8px rgba(255,255,255,0.3);
      }
      .aa-mini-done {
        background: rgba(16,185,129,0.2) !important;
      }
      .aa-mini-done:hover {
        background: rgba(16,185,129,0.6) !important;
        box-shadow: 0 0 8px rgba(16,185,129,0.3) !important;
      }
    `;
  }

  // ==================== MAIN FLOW ====================

  /**
   * Detect total questions from sidebar or page text.
   */
  function detectTotalQuestions() {
    // Method 1: Count sidebar <li> items
    const sidebarItems = document.querySelectorAll('.topicNumber_list li');
    if (sidebarItems.length > 0) return sidebarItems.length;

    // Method 2: Text like "题量: 56"
    const bodyText = document.body.textContent || "";
    const match = bodyText.match(/题量\s*[:：]\s*(\d+)/);
    if (match) return parseInt(match[1]);

    return 0;
  }

  /**
   * Get current question index (0-based) from the page.
   */
  function getCurrentQuestionIndex() {
    // Method 1: sidebar .current li — read the onclick attribute for the index
    const currentLi = document.querySelector('.topicNumber_list li.current');
    if (currentLi) {
      const onclick = currentLi.getAttribute('onclick') || "";
      const match = onclick.match(/getTheQuestionByStart\((\d+)/);
      if (match) return parseInt(match[1]);
      // Fallback: read the displayed number
      const num = parseInt(currentLi.textContent?.trim());
      if (!isNaN(num)) return num - 1;
    }

    // Method 2: question title like "1. xxx"
    const titleEl = document.querySelector('.mark_name');
    if (titleEl) {
      const text = titleEl.innerText?.trim() || "";
      const match = text.match(/^(\d+)/);
      if (match) return parseInt(match[1]) - 1;
    }

    // Method 3: URL parameter start=
    const urlMatch = window.location.search.match(/[?&]start=(\d+)/);
    if (urlMatch) return parseInt(urlMatch[1]);

    return 0;
  }

  /**
   * Navigate to the next question using Chaoxing's own function.
   * Returns false if can't navigate (last question).
   */
  function goToNextQuestion() {
    const currentIndex = getCurrentQuestionIndex();
    const nextIndex = currentIndex + 1;
    const totalQuestions = detectTotalQuestions();

    console.log(`[AutoAnswer] goToNextQuestion: current=${currentIndex}, next=${nextIndex}, total=${totalQuestions}`);

    if (nextIndex >= totalQuestions) {
      console.log("[AutoAnswer] Already on last question.");
      return false;
    }

    // Method 1: Call page's getTheQuestionByStart function directly
    if (typeof getTheQuestionByStart === "function") {
      console.log(`[AutoAnswer] Calling getTheQuestionByStart(${nextIndex}, '0')`);
      getTheQuestionByStart(nextIndex, '0');
      return true;
    }

    // Method 2: Click the corresponding sidebar <li>
    const sidebarItems = document.querySelectorAll('.topicNumber_list li');
    if (nextIndex < sidebarItems.length) {
      console.log(`[AutoAnswer] Clicking sidebar item ${nextIndex + 1}`);
      sidebarItems[nextIndex].click();
      return true;
    }

    // Method 3: Click "下一题" link as last resort
    const nextLink = document.querySelector('.nextDiv a');
    if (nextLink && isVisible(nextLink)) {
      console.log("[AutoAnswer] Clicking .nextDiv a");
      nextLink.click();
      return true;
    }

    console.log("[AutoAnswer] Cannot navigate to next question.");
    return false;
  }

  async function startAutoAnswer() {
    console.log("[AutoAnswer] startAutoAnswer called");
    if (isRunning) {
      console.log("[AutoAnswer] Already running.");
      return;
    }

    isRunning = true;

    const totalQuestions = detectTotalQuestions();
    const currentIndex = getCurrentQuestionIndex();
    console.log(`[AutoAnswer] Total: ${totalQuestions}, Current: ${currentIndex + 1}`);

    // Load accumulated results from storage
    const stored = await new Promise(r => chrome.storage.local.get({
      autoAnswerRunning: false,
      autoAnswerStartTime: Date.now(),
      autoAnswerResults: [],
      autoAnswerSuccessCount: 0,
      autoAnswerFailCount: 0
    }, r));

    const results = stored.autoAnswerResults || [];
    const successCount = stored.autoAnswerSuccessCount || 0;
    const failCount = stored.autoAnswerFailCount || 0;

    // Create progress panel and show accumulated results
    createProgressPanel();
    updateProgress(results.length, totalQuestions, `正在解答第 ${currentIndex + 1} 题...`);
    setDebugState({
      autoAnswerStatus: `正在解答第 ${currentIndex + 1} 题...`,
      autoAnswerCurrentQuestion: "",
      autoAnswerCurrentAnswer: ""
    });

    // Show previous answers in the log
    results.forEach(r => {
      updateProgress(0, 0, null, r);
    });

    // Scan current page for questions
    const questions = scanQuestions();
    if (questions.length === 0) {
      console.log("[AutoAnswer] No questions found.");
      if (results.length > 0) {
        showResult(totalQuestions, successCount, failCount);
      } else {
        stopAutoAnswer();
      }
      isRunning = false;
      return;
    }

    // Save running state
    if (!stored.autoAnswerRunning) {
      chrome.storage.local.set({ autoAnswerRunning: true, autoAnswerStartTime: Date.now() });
    }

    // Answer the question
    const question = questions[0];
    setDebugState({
      autoAnswerStatus: `已识别第 ${currentIndex + 1} 题`,
      autoAnswerCurrentQuestion: question.text,
      autoAnswerCurrentAnswer: ""
    });
    let answerText = null;
    let source = "AI";  // "bank" or "AI"

    // Step 1: Check the local question bank first
    const bankResult = searchQuestionBank(question.text);
    if (bankResult) {
      answerText = bankResult.answer;
      source = "bank";
      console.log(`[AutoAnswer] 📚 题库命中! 相似度=${bankResult.similarity.toFixed(2)}, 答案="${answerText}"`);
    }

    // Step 2: If not in bank, call AI
    if (!answerText) {
      try {
        const answers = await requestAnswers([question]);
        if (answers.length > 0) {
          answerText = answers[0].answer;
        }
      } catch (err) {
        console.error("[AutoAnswer] AI Error:", err);
      }
    }

    // Step 3: Fill and navigate
    if (answerText) {
      // Re-scan to get fresh DOM elements
      const freshQuestions = scanQuestions();
      const target = freshQuestions.length > 0 ? freshQuestions[0] : question;
      fillAnswer(target, answerText);

      const logEntry = `✓ 第${currentIndex + 1}题 [${source}]: ${answerText}`;
      results.push(logEntry);

      chrome.storage.local.set({
        autoAnswerResults: results,
        autoAnswerSuccessCount: successCount + 1
      });
      setDebugState({
        autoAnswerStatus: `第 ${currentIndex + 1} 题已作答`,
        autoAnswerCurrentQuestion: question.text,
        autoAnswerCurrentAnswer: answerText
      });

      updateProgress(
        results.length,
        totalQuestions,
        `已答第 ${currentIndex + 1} 题 (${source})`,
        logEntry
      );

      // Wait then navigate
      await new Promise(async (r) => setTimeout(r, await getAutoAnswerIntervalMs()));

      // Check if stopped during the wait
      if (!isRunning) {
        console.log("[AutoAnswer] Stopped by user, skipping navigation.");
        return;
      }

      if (currentIndex + 1 >= totalQuestions) {
        console.log("[AutoAnswer] Reached last question. Showing result.");
        showResult(totalQuestions, successCount + 1, failCount);
        chrome.storage.local.set({ autoAnswerRunning: false });
      } else {
        console.log("[AutoAnswer] Navigating to next question...");
        goToNextQuestion();
      }
    } else {
      const logEntry = `✗ 第${currentIndex + 1}题: 未获取到答案`;
      results.push(logEntry);

      chrome.storage.local.set({
        autoAnswerResults: results,
        autoAnswerFailCount: failCount + 1
      });
      setDebugState({
        autoAnswerStatus: `第 ${currentIndex + 1} 题未获取到答案`,
        autoAnswerCurrentQuestion: question.text,
        autoAnswerCurrentAnswer: ""
      });

      updateProgress(results.length, totalQuestions, `第 ${currentIndex + 1} 题未获取到答案`, logEntry);
      await new Promise(async (r) => setTimeout(r, await getAutoAnswerIntervalMs()));

      if (!isRunning) {
        console.log("[AutoAnswer] Stopped by user, skipping navigation.");
        return;
      }

      if (currentIndex + 1 >= totalQuestions) {
        showResult(totalQuestions, successCount, failCount + 1);
        chrome.storage.local.set({ autoAnswerRunning: false });
      } else {
        goToNextQuestion();
      }
    }

    isRunning = false;
  }

  async function answerWordQuestion() {
    const questions = scanQuestions();
    if (!questions.length) {
      setDebugState({ autoAnswerStatus: "未识别到题目" });
      return;
    }
    const question = questions[0];
    setDebugState({
      autoAnswerStatus: "正在单次作答...",
      autoAnswerCurrentQuestion: question.text,
      autoAnswerCurrentAnswer: ""
    });
    try {
      let answerText = null;
      const bankResult = searchQuestionBank(question.text);
      if (bankResult) {
        answerText = bankResult.answer;
      }
      if (!answerText) {
        answerText = await requestWordAnswer(question);
      }
      if (!answerText) {
        setDebugState({ autoAnswerStatus: "单次作答未获取到答案", autoAnswerCurrentAnswer: "" });
        return;
      }
      const freshQuestions = scanQuestions();
      const target = freshQuestions.length > 0 ? freshQuestions[0] : question;
      fillAnswer(target, answerText.trim());
      setDebugState({
        autoAnswerStatus: "单次作答完成",
        autoAnswerCurrentQuestion: question.text,
        autoAnswerCurrentAnswer: answerText.trim()
      });
    } catch (err) {
      console.error("[AutoAnswer] Word answer error:", err);
      setDebugState({
        autoAnswerStatus: `单次作答失败：${err.message || err}`,
        autoAnswerCurrentQuestion: question.text,
        autoAnswerCurrentAnswer: ""
      });
    }
  }

  /**
   * Check if auto-answer was in progress (called on page load).
   * If so, resume automatically.
   */
  function checkAndResume() {
    console.log("[AutoAnswer] checkAndResume called");
    chrome.storage.local.get({
      autoAnswerRunning: false,
      autoAnswerStartTime: 0,
      autoAnswerResults: [],
      autoAnswerSuccessCount: 0,
      autoAnswerFailCount: 0
    }, (result) => {
      console.log("[AutoAnswer] Storage state:", result.autoAnswerRunning, "results:", result.autoAnswerResults.length);
      if (result.autoAnswerRunning) {
        // Check if not too old (timeout after 30 minutes)
        if (Date.now() - result.autoAnswerStartTime > 30 * 60 * 1000) {
          console.log("[AutoAnswer] Auto-answer timed out, clearing state.");
          chrome.storage.local.set({ autoAnswerRunning: false, autoAnswerResults: [] });
          return;
        }
        console.log(`[AutoAnswer] Resuming auto-answer... (${result.autoAnswerResults.length} answered so far)`);
        // Delay to let page fully load
        setTimeout(() => startAutoAnswer(), 2000);
      }
    });
  }

  function stopAutoAnswer() {
    isRunning = false;
    chrome.storage.local.set({
      autoAnswerRunning: false,
      autoAnswerStatus: "已停止",
      autoAnswerResults: [],
      autoAnswerSuccessCount: 0,
      autoAnswerFailCount: 0,
      autoAnswerMinimized: true
    });
    if (progressPanel) {
      const host = document.getElementById("auto-answer-host");
      if (host) host.remove();
      progressPanel = null;
      shadowRoot = null;
    }
  }

  // ==================== KEYBOARD SHORTCUTS ====================
  // Listen for Alt+C (start) and Alt+V (stop) directly in the page.
  // This avoids Chrome's commands API limitation where new shortcuts
  // are NOT registered on extension update — only on fresh install.

  let lastShortcutTime = 0;
  window.addEventListener("keydown", async function(e) {
    const configured = await new Promise((resolve) => {
      chrome.storage.local.get({
        customShortcutAutoStart: "Alt+C",
        customShortcutAutoStop: "Alt+V",
        customShortcutWordAnswer: "Alt+W"
      }, resolve);
    });
    const pressed = getShortcutString(e);
    if (!pressed) return;
    // start auto-answer
    if (pressed === configured.customShortcutAutoStart) {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastShortcutTime < 500) return; // debounce
      lastShortcutTime = now;

      if (isRunning) {
        console.log("[AutoAnswer] Alt+C: Already running, ignoring.");
        return;
      }
      console.log("[AutoAnswer] Alt+C: Starting auto-answer...");
      chrome.storage.local.set({
        autoAnswerRunning: true,
        autoAnswerStartTime: Date.now(),
        autoAnswerResults: [],
        autoAnswerSuccessCount: 0,
        autoAnswerFailCount: 0
      });
      startAutoAnswer();
      return;
    }

    // stop auto-answer
    if (pressed === configured.customShortcutAutoStop) {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastShortcutTime < 500) return; // debounce
      lastShortcutTime = now;

      if (!isRunning) {
        console.log("[AutoAnswer] Alt+V: Not running, ignoring.");
        return;
      }
      console.log("[AutoAnswer] Alt+V: Stopping auto-answer!");
      stopAutoAnswer();
      return;
    }

    if (pressed === configured.customShortcutWordAnswer) {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastShortcutTime < 500) return;
      lastShortcutTime = now;
      answerWordQuestion();
      return;
    }
  }, true);

  // ==================== MESSAGE LISTENER ====================

  console.log("[AutoAnswer] Registering message listener...");
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    console.log("[AutoAnswer] Received message:", msg.action);
    if (msg.action === "START_AUTO_ANSWER") {
      console.log("[AutoAnswer] Starting auto-answer...");
      // Clear previous results and start fresh
      chrome.storage.local.set({
        autoAnswerRunning: true,
        autoAnswerStartTime: Date.now(),
        autoAnswerResults: [],
        autoAnswerSuccessCount: 0,
        autoAnswerFailCount: 0
      });
      startAutoAnswer();
      sendResponse({ success: true });
      return true;
    }

    if (msg.action === "STOP_AUTO_ANSWER") {
      stopAutoAnswer();
      chrome.storage.local.set({ autoAnswerRunning: false });
      sendResponse({ success: true });
      return true;
    }

    if (msg.action === "ANSWER_WORD_QUESTION") {
      answerWordQuestion();
      sendResponse({ success: true });
      return true;
    }
  });

  // ==================== AUTO-RESUME ON PAGE LOAD ====================
  // If auto-answer was running before a page reload, resume automatically.
  checkAndResume();

  // Expose global function for manual testing
  window.__startAutoAnswer = function() {
    console.log("[AutoAnswer] Manual start triggered");
    chrome.storage.local.set({
      autoAnswerRunning: true,
      autoAnswerStartTime: Date.now(),
      autoAnswerResults: [],
      autoAnswerSuccessCount: 0,
      autoAnswerFailCount: 0
    });
    startAutoAnswer();
  };

  console.log("[AutoAnswer] Ready. Use __startAutoAnswer() to test manually.");
})();

