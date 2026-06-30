(function () {
  if (window.__aiAutoAnswerLoaded_v1) return;
  window.__aiAutoAnswerLoaded_v1 = true;

  const DEFAULTS = {
    aiAutoAnswerRunning: false,
    aiAutoAnswerIntervalMs: 1500,
    aiAutoAnswerAutoSubmit: true,
    aiAutoAnswerAutoNext: true,
    aiAutoAnswerResults: [],
    aiAutoAnswerLastKey: "",
    aiAutoAnswerStatus: "就绪"
  };
  const MAX_PROMPT_CHARS = 6000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let inStep = false;
  let bank = [];
  let bankLoaded = false;

  const storageGet = (defaults = DEFAULTS) => new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  const storageSet = (values) => new Promise((resolve) => chrome.storage.local.set(values, resolve));

  function textOf(el) {
    if (!el) return "";
    return String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }
  function cleanText(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .replace(/^\s*\d+\s*[\.、．)]\s*/, "")
      .replace(/[（(]\s*(单选题|多选题|判断题|填空题|简答题|综合题)[^）)]*[）)]/g, "")
      .trim();
  }
  function norm(s) {
    return cleanText(s).replace(/[\s\r\n\t.,/#!$%^&*;:{}=\-_`~()（）?？_—\[\]【】]/g, "").toLowerCase();
  }
  function similarity(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    const grams = (s) => {
      const set = new Set();
      if (s.length < 2) { set.add(s); return set; }
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      return set;
    };
    const ax = grams(x), by = grams(y);
    let hit = 0;
    for (const g of ax) if (by.has(g)) hit++;
    return (2 * hit) / (ax.size + by.size);
  }

  async function loadBank() {
    if (bankLoaded) return bank;
    bankLoaded = true;
    try {
      const res = await fetch(chrome.runtime.getURL("questions.json"));
      const data = await res.json();
      bank = Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn("AI Auto Answer: 本地题库加载失败", e);
      bank = [];
    }
    return bank;
  }

  async function findLocalAnswer(questionText) {
    await loadBank();
    let best = null;
    let bestScore = 0;
    for (const item of bank) {
      const candidateText = item.prompt || item.question || item.text || item.title || "";
      const score = similarity(questionText, candidateText);
      if (score > bestScore) { bestScore = score; best = item; }
      if (score >= 0.995) break;
    }
    if (best && bestScore >= 0.82) {
      return { answer: best.answer || best.result || best.value || "", source: "本地题库", score: bestScore };
    }
    return null;
  }

  function visible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function optionLetter(i) { return String.fromCharCode(65 + i); }
  function optionTextFrom(el, fallbackLetter) {
    let t = textOf(el).replace(/^\s*[A-Z]\s*[\.、．)]?\s*/i, "").trim();
    if (!t && el?.labels && el.labels[0]) t = textOf(el.labels[0]);
    return t || fallbackLetter;
  }

  function collectOptions(container) {
    const options = [];
    const seen = new Set();
    const getClickable = (el) => {
      if (!el) return el;
      if (el.tagName === "INPUT") {
        return el.closest("label") || (el.id ? container.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null) || el;
      }
      return el.closest(".answerBg,label,li,[role=radio],[role=checkbox],[role=option],button,a") || el;
    };
    const add = (el, text, letter) => {
      if (!el || seen.has(el)) return;
      if (!visible(el) && el.tagName !== "INPUT") return;
      seen.add(el);
      const clickable = getClickable(el);
      options.push({
        element: clickable,
        input: el.tagName === "INPUT" ? el : clickable?.querySelector?.("input[type=radio],input[type=checkbox]") || null,
        text: text || optionTextFrom(clickable || el, letter),
        letter: letter || optionLetter(options.length)
      });
    };

    container.querySelectorAll(".answerBg,.singleoption,.multioption,.judgeoption,.option,.choices li,.choice li,[class*=option],[class*=answerBg]").forEach((el) => {
      const letterEl = el.querySelector(".addChoice,.addMultipleChoice,.num_option,.num_option_dx,[data]");
      const letter = (letterEl?.getAttribute("data") || letterEl?.textContent || "").trim().match(/[A-Z]/i)?.[0]?.toUpperCase() || optionLetter(options.length);
      const t = textOf(el).replace(/^\s*[A-Z]\s*[\.、．)]?\s*/i, "");
      if (t && t.length < 500) add(el, t, letter);
    });

    container.querySelectorAll("input[type=radio],input[type=checkbox]").forEach((input) => {
      const label = input.closest("label") || (input.id ? container.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null) || input.parentElement;
      add(input, optionTextFrom(label || input, optionLetter(options.length)), optionLetter(options.length));
    });

    container.querySelectorAll("[role=radio],[role=checkbox],[role=option]").forEach((el) => {
      add(el, optionTextFrom(el, optionLetter(options.length)), optionLetter(options.length));
    });

    return options.filter((o, i, arr) => i === arr.findIndex(x => x.text === o.text || x.element === o.element || (o.input && x.input === o.input))).slice(0, 10);
  }

  function findInputs(container) {
    return Array.from(container.querySelectorAll("textarea,input[type=text],input:not([type]),[contenteditable=true],iframe[id*=ueditor],iframe.edui-default"))
      .filter(el => visible(el) || el.tagName === "IFRAME")
      .filter(el => !/search|keyword|user|name|phone|mail|pass|captcha|验证码|搜索|评论|comment|chat/i.test(`${el.name || ""} ${el.id || ""} ${el.className || ""} ${el.placeholder || ""}`));
  }

  function inferType(container, options, inputs) {
    const text = textOf(container);
    const cls = `${container.className || ""} ${container.getAttribute("typename") || ""}`.toLowerCase();
    const qid = container.getAttribute?.("data") || container.querySelector?.("#questionId")?.value || document.querySelector("#questionId")?.value || "";
    const cxType = qid ? (container.querySelector?.(`input[name="type${CSS.escape(qid)}"]`) || document.querySelector(`input[name="type${CSS.escape(qid)}"]`))?.value : "";
    if (cxType === "1") return "multi";
    if (cxType === "2" || cxType === "9" || cxType === "10" || cxType === "4" || cxType === "5" || cxType === "6" || cxType === "7" || cxType === "8" || cxType === "18") return "fill";
    if (cxType === "3") return "judge";
    if (cxType === "0") return "single";
    if (inputs.length && !options.length) return "fill";
    if (/多选|multiple|checkbox|multi/.test(cls + text) || container.querySelector("input[type=checkbox],[role=checkbox],.num_option_dx,.addMultipleChoice")) return "multi";
    const joined = options.map(o => norm(o.text)).join("|");
    if (options.length === 2 && /(正确|错误|对|错|true|false|是|否)/i.test(joined)) return "judge";
    return options.length ? "single" : "fill";
  }

  function findQuestionText(container, options) {
    const selectors = [".mark_name", ".question-title", ".subject-title", ".title", ".stem", "[class*=question-title]", "[class*=mark]", "h1", "h2", "h3", "p"];
    for (const sel of selectors) {
      const el = container.querySelector(sel);
      const t = cleanText(textOf(el));
      if (t && t.length >= 4 && t.length < 1500) return t;
    }
    let raw = textOf(container);
    for (const o of options) raw = raw.replace(String(o.text || ""), " ");
    return cleanText(raw).slice(0, 1500);
  }

  function scanQuestions() {
    const roots = [];
    document.querySelectorAll(".questionLi,.question-item,.question,.subject,.exam-question,.topic-item,[class*=question],[class*=subject],[class*=topic]").forEach(el => {
      if (visible(el) && (el.querySelector("input[type=radio],input[type=checkbox],textarea,input[type=text],[contenteditable=true],.answerBg,.num_option,[role=radio],[role=checkbox]") || /题|question|subject|topic/i.test(`${el.className || ""} ${el.id || ""}`))) roots.push(el);
    });
    if (!roots.length) {
      document.querySelectorAll("input[type=radio],input[type=checkbox],textarea,input[type=text],[contenteditable=true],.answerBg,[role=radio],[role=checkbox]").forEach(input => {
        const root = input.closest(".questionLi,.question,form,article,section,.main,.content,.container") || document.body;
        if (root && !roots.includes(root)) roots.push(root);
      });
    }
    const dedup = roots.filter((r, i, arr) => !arr.some((x, j) => i !== j && x.contains(r)));
    const questions = [];
    for (const root of dedup) {
      const options = collectOptions(root);
      const inputs = findInputs(root);
      const qid = root.getAttribute?.("data") || document.querySelector("#questionId")?.value || "";
      const hasChaoxingAnswer = !!qid && !!(root.querySelector?.(`#answer${CSS.escape(qid)},[name="answer${CSS.escape(qid)}"],[name^="answerEditor${CSS.escape(qid)}"]`) || document.querySelector(`#answer${CSS.escape(qid)},[name="answer${CSS.escape(qid)}"],[name^="answerEditor${CSS.escape(qid)}"]`));
      if (!options.length && !inputs.length && !hasChaoxingAnswer) continue;
      const text = findQuestionText(root, options);
      if (!text || text.length < 2) continue;
      questions.push({ element: root, text, type: inferType(root, options, inputs), options, inputs });
    }
    return questions;
  }

  function buildPrompt(question) {
    const typeLabel = { single: "单选题", multi: "多选题", judge: "判断题", fill: "填空/简答题" }[question.type] || "题目";
    const opts = question.options.map(o => `${o.letter}. ${o.text}`).join("\n");
    return [
      "你是自动答题助手。只返回最终答案，不要解释，不要 Markdown。",
      `题型：${typeLabel}`,
      "返回格式：单选只返回一个选项字母；多选只返回多个选项字母如 ACD；判断只返回 对 或 错；填空/简答只返回答案文本。",
      `题目：${question.text}`,
      opts ? `选项：\n${opts}` : ""
    ].join("\n").slice(0, MAX_PROMPT_CHARS);
  }

  function askAI(question) {
    return new Promise((resolve) => {
      let answer = "";
      let done = false;
      const port = chrome.runtime.connect({ name: "ai-stream" });
      const finish = (value) => {
        if (done) return;
        done = true;
        try { port.disconnect(); } catch (_) {}
        resolve((value || "").trim());
      };
      port.onMessage.addListener((msg) => {
        if (msg.action === "chunk") answer += msg.text || "";
        if (msg.action === "done") finish(answer);
        if (msg.action === "error") finish("");
      });
      port.onDisconnect.addListener(() => finish(answer));
      port.postMessage({ action: "REQUEST_AI", text: buildPrompt(question) });
      setTimeout(() => finish(answer), 60000);
    });
  }

  function normalizeAnswer(answer, question) {
    let a = String(answer || "").trim().replace(/^答案[:：\s]*/i, "").replace(/[`*_#>]/g, "").trim();
    if (question.type === "judge") {
      if (/错|错误|不对|false|否|×|✗/i.test(a)) return "错";
      if (/对|正确|true|是|√|✓/i.test(a)) return "对";
    }
    if (question.type === "single" || question.type === "multi") {
      const letters = Array.from(new Set((a.toUpperCase().match(/[A-J]/g) || []).filter(ch => question.options.some(o => o.letter === ch))));
      if (letters.length) return question.type === "single" ? letters[0] : letters.join("");
      const found = question.options.find(o => norm(a).includes(norm(o.text)) || norm(o.text).includes(norm(a)));
      if (found) return found.letter;
    }
    return a;
  }

  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); }
  function clickElement(el) {
    if (!el) return false;
    el.scrollIntoView?.({ block: "center", inline: "center" });
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    el.click?.();
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    fire(el, "change");
    return true;
  }

  function isOptionSelected(option) {
    const input = option.input || (option.element?.matches?.("input[type=radio],input[type=checkbox]") ? option.element : null);
    if (input) return !!input.checked;
    const el = option.element;
    if (!el) return false;
    const attr = `${el.getAttribute("aria-checked") || ""} ${el.getAttribute("aria-selected") || ""}`.toLowerCase();
    const cls = String(el.className || "").toLowerCase();
    return attr.includes("true") || /selected|checked|active|current|on|已选/.test(cls);
  }

  function fillChoice(question, answer) {
    const wanted = new Set(question.type === "multi" ? (answer.toUpperCase().match(/[A-J]/g) || []) : [answer.toUpperCase().match(/[A-J]/)?.[0]].filter(Boolean));
    if (question.type === "judge" && !wanted.size) {
      const idx = answer === "错" ? 1 : 0;
      if (question.options[idx]) wanted.add(question.options[idx].letter);
    }
    if (fillChaoxingChoice(question, wanted)) return true;
    let changed = false;
    for (const option of question.options) {
      const should = wanted.has(option.letter);
      const el = option.element;
      const input = option.input || (el?.matches?.("input[type=radio],input[type=checkbox]") ? el : null);
      if (!should && question.type !== "multi") continue;
      if (input) {
        if (input.type === "radio" && should) {
          if (!input.checked) clickElement(el !== input ? el : input);
          input.checked = true;
          fire(input, "input"); fire(input, "change");
          changed = true;
        }
        if (input.type === "checkbox" && input.checked !== should) {
          clickElement(el !== input ? el : input);
          input.checked = should;
          fire(input, "input"); fire(input, "change");
          changed = true;
        }
      } else if (should) {
        if (!isOptionSelected(option)) clickElement(el);
        changed = true;
      }
      if (should && question.type !== "multi") break;
    }
    return changed;
  }

  function fillChaoxingChoice(question, wanted) {
    const qid =
      question.element?.getAttribute?.("data") ||
      question.element?.querySelector?.(".addChoice,.addMultipleChoice,.num_option,.num_option_dx")?.getAttribute("qid") ||
      document.querySelector("#questionId")?.value ||
      "";
    if (!qid) return false;

    const safeQid = String(qid).replace(/[^a-zA-Z0-9_-]/g, "");
    const choiceNodes = Array.from(question.element?.querySelectorAll?.(`.choice${safeQid}, .addChoice[qid="${CSS.escape(qid)}"], .addMultipleChoice[qid="${CSS.escape(qid)}"], .num_option[qid="${CSS.escape(qid)}"], .num_option_dx[qid="${CSS.escape(qid)}"]`) || []);
    if (!choiceNodes.length) return false;

    const isMulti = question.type === "multi" || choiceNodes.some((node) => node.classList.contains("addMultipleChoice") || node.classList.contains("num_option_dx"));
    let applied = false;
    for (const node of choiceNodes) {
      const letter = (node.getAttribute("data") || textOf(node)).trim().match(/[A-J]/i)?.[0]?.toUpperCase();
      const should = wanted.has(letter);
      const parent = node.closest(".answerBg") || node.parentElement;
      if (isMulti) {
        node.classList.toggle("check_answer_dx", should);
        node.classList.remove("check_answer");
      } else {
        node.classList.toggle("check_answer", should);
        node.classList.remove("check_answer_dx");
      }
      parent?.setAttribute("aria-checked", should ? "true" : "false");
      parent?.setAttribute("aria-pressed", should ? "true" : "false");
      if (should) {
        clickElement(parent || node);
        // Some Chaoxing pages toggle on click; force the final state again after the page handler.
        if (isMulti) node.classList.add("check_answer_dx");
        else node.classList.add("check_answer");
        parent?.setAttribute("aria-checked", "true");
        parent?.setAttribute("aria-pressed", "true");
        applied = true;
      }
    }

    const answerValue = choiceNodes
      .filter((node) => isMulti ? node.classList.contains("check_answer_dx") : node.classList.contains("check_answer"))
      .map((node) => (node.getAttribute("data") || textOf(node)).trim().match(/[A-J]/i)?.[0]?.toUpperCase() || "")
      .filter(Boolean)
      .join("");

    const hidden = document.getElementById(`answer${qid}`) || question.element?.querySelector?.(`#answer${CSS.escape(qid)}`);
    if (hidden) {
      hidden.value = answerValue;
      fire(hidden, "input");
      fire(hidden, "change");
    }
    const isAnswered = document.getElementById("isAnswered");
    if (isAnswered && answerValue) {
      isAnswered.value = "true";
      fire(isAnswered, "change");
    }
    return applied && !!answerValue;
  }

  function setValue(el, value) {
    if (el.tagName === "IFRAME") {
      try {
        const doc = el.contentDocument || el.contentWindow?.document;
        if (doc?.body) {
          doc.body.innerHTML = `<p>${String(value).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</p>`;
          fire(doc.body, "input"); fire(doc.body, "change"); return true;
        }
      } catch (_) {}
      return false;
    }
    if (el.isContentEditable) {
      el.focus(); el.textContent = value; fire(el, "input"); fire(el, "change"); fire(el, "blur"); return true;
    }
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    el.focus();
    if (setter) setter.call(el, value); else el.value = value;
    fire(el, "input"); fire(el, "change"); fire(el, "blur");
    return true;
  }

  function fillAnswer(question, answer) {
    const normalized = normalizeAnswer(answer, question);
    if (question.type === "single" || question.type === "multi" || question.type === "judge") return fillChoice(question, normalized);
    if (fillChaoxingText(question, normalized)) return true;
    const parts = String(normalized).split(/\s*(?:#|\||；|;|\n)\s*/).filter(Boolean);
    let ok = false;
    question.inputs.forEach((input, i) => { ok = setValue(input, parts[i] || normalized) || ok; });
    return ok;
  }

  function fillChaoxingText(question, answer) {
    const qid =
      question.element?.getAttribute?.("data") ||
      document.querySelector("#questionId")?.value ||
      question.element?.querySelector?.("[name=questionId]")?.value ||
      "";
    if (!qid) return false;

    const hidden =
      document.getElementById(`answer${qid}`) ||
      document.querySelector(`input[name="answer${CSS.escape(qid)}"],textarea[name="answer${CSS.escape(qid)}"]`);
    const cxType = (document.querySelector(`input[name="type${CSS.escape(qid)}"]`) || question.element?.querySelector?.(`input[name="type${CSS.escape(qid)}"]`))?.value || "";
    const parts = String(answer || "").split(/\s*(?:#|\||；|;|\n)\s*/).filter(Boolean);
    let changed = false;

    // 学习通填空题通常是 answerEditor{qid}1/2...，提交前会同步成 JSON。
    const blankEditors = Array.from(document.querySelectorAll(`textarea[name^="answerEditor${CSS.escape(qid)}"],iframe[id^="answerEditor${CSS.escape(qid)}"]`));
    if (blankEditors.length) {
      const answerItems = [];
      blankEditors.forEach((el, i) => {
        const value = parts[i] || answer;
        setValue(el, value);
        answerItems.push({ name: String(i + 1), content: value });
        changed = true;
      });
      if (hidden) {
        hidden.value = JSON.stringify(answerItems);
        fire(hidden, "input");
        fire(hidden, "change");
      }
    }

    // 简答/论述等富文本题通常直接使用 answer{qid} 编辑器/textarea。
    if (!changed) {
      const directEditors = Array.from(document.querySelectorAll(`textarea#answer${CSS.escape(qid)},textarea[name="answer${CSS.escape(qid)}"],iframe#answer${CSS.escape(qid)},[contenteditable=true]`))
        .filter((el) => question.element.contains(el) || el.id === `answer${qid}` || el.name === `answer${qid}`);
      if (directEditors.length) {
        directEditors.forEach((el) => {
          setValue(el, answer);
          changed = true;
        });
      }
    }

    // 如果只有隐藏域，也写入学习通可提交的值：填空为 JSON，简答为 HTML/文本。
    if (hidden && (changed || !hidden.value) && !blankEditors.length) {
      if (cxType === "2" || cxType === "9" || cxType === "10" || parts.length > 1) {
        hidden.value = JSON.stringify((parts.length ? parts : [answer]).map((content, i) => ({ name: String(i + 1), content })));
      } else {
        hidden.value = answer;
      }
      fire(hidden, "input");
      fire(hidden, "change");
      changed = true;
    }

    const isAnswered = document.getElementById("isAnswered");
    if (isAnswered && changed) {
      isAnswered.value = "true";
      fire(isAnswered, "change");
    }
    return changed;
  }

  function findSubmitButton() {
    return Array.from(document.querySelectorAll("button,a,input[type=button],input[type=submit],.btn,[role=button]"))
      .find(el => visible(el) && /^(提交|保存|确定|确认|作答|提交答案|submit)$/i.test((el.value || textOf(el)).trim()));
  }

  function currentQuestionKey(q) {
    const url = new URL(location.href);
    const start = url.searchParams.get("start") || url.searchParams.get("q") || url.searchParams.get("question") || "";
    return `${location.pathname}|${start}|${norm(q.text).slice(0, 80)}`;
  }
  function detectCurrentIndex(question) {
    const url = new URL(location.href);
    const start = Number(url.searchParams.get("start"));
    if (Number.isFinite(start) && start >= 0) return start;
    const active = document.querySelector(".topicNumber_list li.current,.topicNumber_list .current,[class*=topic] .active,[class*=question] .active,.active");
    const n = Number(textOf(active).match(/\d+/)?.[0]);
    if (n) return n - 1;
    const m = question?.text?.match(/^\s*(\d+)\s*[\.、．)]/);
    if (m) return Number(m[1]) - 1;
    return -1;
  }
  function goNext(question) {
    const current = detectCurrentIndex(question);
    const nextIndex = current >= 0 ? current + 1 : -1;
    const navItems = Array.from(document.querySelectorAll(".topicNumber_list li,.topicNumber_list a,[class*=topicNumber] li,[class*=questionNumber] li,[class*=number] button,[class*=number] a")).filter(visible);
    if (nextIndex >= 0 && navItems[nextIndex]) { clickElement(navItems[nextIndex]); return true; }
    const buttons = Array.from(document.querySelectorAll("button,a,input[type=button],.btn,[role=button]")).filter(visible);
    const nextBtn = buttons.find(el => /下一题|下一页|下一步|next|>|›|→/i.test((el.value || textOf(el) || el.getAttribute("title") || "").trim()));
    if (nextBtn) { clickElement(nextBtn); return true; }
    const url = new URL(location.href);
    if (url.searchParams.has("start") && current >= 0) {
      url.searchParams.set("start", String(current + 1));
      location.href = url.toString();
      return true;
    }
    return false;
  }

  async function setStatus(text) {
    await storageSet({ aiAutoAnswerStatus: text, aiAutoAnswerStatusTime: Date.now() });
    console.log("AI Auto Answer:", text);
  }

  async function runStep() {
    if (inStep) return;
    inStep = true;
    try {
      const settings = await storageGet();
      if (!settings.aiAutoAnswerRunning) return;
      const questions = scanQuestions();
      if (!questions.length) {
        await setStatus("未识别到题目，稍后重试");
        setTimeout(runStep, Math.max(1000, Number(settings.aiAutoAnswerIntervalMs) || 1500));
        return;
      }
      const question = questions[0];
      const key = currentQuestionKey(question);
      if (settings.aiAutoAnswerLastKey === key) {
        if (settings.aiAutoAnswerAutoNext && goNext(question)) await setStatus("当前题已处理，跳到下一题");
        else { await setStatus("当前题已处理，未找到下一题"); await storageSet({ aiAutoAnswerRunning: false }); }
        return;
      }
      await setStatus(`识别题目：${question.text.slice(0, 40)}`);
      const local = await findLocalAnswer(question.text);
      let answer = local?.answer || "";
      const source = local ? local.source : "AI";
      if (!answer) answer = await askAI(question);
      if (!answer) throw new Error("未获得答案");
      const ok = fillAnswer(question, answer);
      const result = { time: Date.now(), url: location.href, question: question.text, answer, source, ok };
      const results = Array.isArray(settings.aiAutoAnswerResults) ? settings.aiAutoAnswerResults.concat(result).slice(-200) : [result];
      await storageSet({ aiAutoAnswerResults: results, aiAutoAnswerLastKey: key });
      await setStatus(`${ok ? "已作答" : "填写可能失败"}：${answer}（${source}）`);
      if (!ok) {
        await storageSet({ aiAutoAnswerRunning: false });
        return;
      }
      if (settings.aiAutoAnswerAutoSubmit) {
        const submit = findSubmitButton();
        if (submit) { await sleep(250); clickElement(submit); await setStatus("已点击提交/保存"); }
      }
      await sleep(Math.max(300, Number(settings.aiAutoAnswerIntervalMs) || 1500));
      const latest = await storageGet();
      if (latest.aiAutoAnswerRunning && latest.aiAutoAnswerAutoNext) {
        if (!goNext(question)) { await setStatus("未找到下一题，自动答题结束"); await storageSet({ aiAutoAnswerRunning: false }); }
      }
    } catch (e) {
      console.error("AI Auto Answer step failed", e);
      await setStatus(`出错：${e.message || e}`);
      await storageSet({ aiAutoAnswerRunning: false });
    } finally {
      inStep = false;
    }
  }

  async function startAutoAnswer() {
    const settings = await storageGet();
    await storageSet({ aiAutoAnswerRunning: true, aiAutoAnswerStartTime: Date.now(), aiAutoAnswerIntervalMs: Number(settings.aiAutoAnswerIntervalMs) || 1500, aiAutoAnswerLastKey: "" });
    await setStatus("自动答题已启动");
    setTimeout(runStep, 300);
  }
  async function stopAutoAnswer() {
    await storageSet({ aiAutoAnswerRunning: false, aiAutoAnswerStatus: "已停止" });
    console.log("AI Auto Answer: 已停止");
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "START_AUTO_ANSWER") { startAutoAnswer().then(() => sendResponse({ success: true })); return true; }
    if (msg.action === "STOP_AUTO_ANSWER") { stopAutoAnswer().then(() => sendResponse({ success: true })); return true; }
    if (msg.action === "AUTO_ANSWER_STATUS") { storageGet().then((s) => sendResponse({ success: true, running: !!s.aiAutoAnswerRunning, status: s.aiAutoAnswerStatus || "" })); return true; }
  });

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); e.stopPropagation(); startAutoAnswer(); }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "v") { e.preventDefault(); e.stopPropagation(); stopAutoAnswer(); }
  }, true);

  storageGet().then((s) => { if (s.aiAutoAnswerRunning) setTimeout(runStep, 1200); });
})();
