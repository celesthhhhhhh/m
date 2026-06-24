/**
 * Memory RAG — SillyTavern Extension
 * Долгосрочная память на основе RAG (Retrieval-Augmented Generation)
 *
 * v2.0 — новое:
 *  1. 📚 Просмотр/редактирование/удаление воспоминаний (Saved Memories)
 *  2. 🖥  Debug-консоль с live-логом активаций (хранит 200 последних записей)
 *  3. 🔌 Выбор модели embedding для кастомного API (поле «model»)
 *  4. 🔃 Сканирование старого чата и создание воспоминаний
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const EXT_NAME = 'memory-rag';

// ════════════════════════════════════════════════════════════
// DEFAULT SETTINGS
// ════════════════════════════════════════════════════════════

const defaultSettings = {
  enabled: true,
  embeddingProvider: 'local',
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  customEmbeddingUrl: '',
  customEmbeddingKey: '',
  customEmbeddingModel: '',        // NEW: model name for custom/openai API
  embeddingDimension: 384,
  vectorDBType: 'json',
  chromaUrl: 'http://localhost:8000',
  qdrantUrl: 'http://localhost:6333',
  qdrantApiKey: '',
  maxMemories: 1000,
  llmClassifier: false,
  autoExtractEvery: 3,
  minImportanceScore: 0.2,
  topK: 5,
  similarityThreshold: 0.55,
  rankingWeights: { similarity: 0.7, importance: 0.2, recency: 0.1 },
  injectPosition: 'system',
  memoryHeader: '## Memory\n\n',
  maxMemoryTokens: 800,
  debugMode: false,
};

function cfg() { return extension_settings[EXT_NAME]; }

// ════════════════════════════════════════════════════════════
// NEW: DEBUG LOG  (ring-buffer, 200 entries)
// ════════════════════════════════════════════════════════════

const _debugLog = [];
const DEBUG_MAX = 200;

function _pushLog(level, ...args) {
  const ts  = new Date().toLocaleTimeString('ru', { hour12: false });
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  _debugLog.push({ ts, level, msg });
  if (_debugLog.length > DEBUG_MAX) _debugLog.shift();
  _refreshDebugConsole();
}

// Public log helpers — replace original plain `log()` so all events go to UI too
function log(...a)     { if (cfg()?.debugMode) console.log('[MemoryRAG]', ...a); _pushLog('INFO', ...a); }
function logWarn(...a) { console.warn('[MemoryRAG]', ...a);  _pushLog('WARN', ...a); }
function logErr(...a)  { console.error('[MemoryRAG]', ...a); _pushLog('ERR',  ...a); }

function _refreshDebugConsole() {
  const el = document.getElementById('mrag-debug-output');
  if (!el) return;
  // Only re-render when section is open
  const section = document.getElementById('mrag-debug-section');
  if (section && !section.open) return;
  _renderDebugLog(el);
}

function _renderDebugLog(el) {
  const colors = {
    INFO:   '#a0c4ff',
    WARN:   '#ffd166',
    ERR:    '#ef476f',
    STORED: '#06d6a0',
    INJECT: '#c77dff',
    SCAN:   '#fdca40',
  };
  el.innerHTML = _debugLog.slice().reverse().map(e => {
    const c = colors[e.level] || '#ccc';
    return `<div style="margin-bottom:2px">` +
      `<span style="color:#666;font-size:10px">${e.ts}</span> ` +
      `<span style="color:${c};font-weight:700">[${e.level}]</span> ` +
      `<span>${_esc(e.msg)}</span></div>`;
  }).join('');
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ════════════════════════════════════════════════════════════
// STYLES
// ════════════════════════════════════════════════════════════

function injectStyles() {
  if (document.getElementById('mrag-styles')) return;
  const el = document.createElement('style');
  el.id = 'mrag-styles';
  el.textContent = `
.mrag-panel{padding:6px 0;font-size:13px;}
.mrag-section{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:12px 14px;margin-bottom:8px;}
.mrag-section--actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.mrag-collapsible{padding:0;}
.mrag-summary{padding:10px 14px;cursor:pointer;user-select:none;font-weight:600;list-style:none;display:flex;align-items:center;}
.mrag-summary::-webkit-details-marker{display:none;}
.mrag-summary::after{content:'▸';margin-left:auto;font-size:11px;transition:transform .15s;}
details[open]>.mrag-summary::after{transform:rotate(90deg);}
.mrag-body{padding:0 14px 12px;}
.mrag-label{display:block;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.5;margin:10px 0 4px;}
.mrag-label--main{font-size:14px;font-weight:700;text-transform:none;letter-spacing:0;opacity:1;display:flex;align-items:center;gap:8px;}
.mrag-description,.mrag-hint{font-size:11px;opacity:.45;margin:4px 0 0;line-height:1.5;}
.mrag-badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;background:#7c6aff;color:#fff;}
.mrag-input,.mrag-select{width:100%;padding:6px 10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:4px;color:var(--SmartThemeBodyColor,#eee);font-size:13px;outline:none;box-sizing:border-box;transition:border-color .15s;}
.mrag-input:focus,.mrag-select:focus{border-color:rgba(255,255,255,.35);}
.mrag-row{display:flex;align-items:center;gap:8px;}
.mrag-row--spread{justify-content:space-between;}
.mrag-range{-webkit-appearance:none;width:calc(100% - 44px);height:4px;background:rgba(255,255,255,.15);border-radius:2px;outline:none;vertical-align:middle;}
.mrag-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#7c6aff;cursor:pointer;}
.mrag-rval{display:inline-block;width:36px;text-align:right;font-size:12px;color:#a78bfa;font-weight:600;vertical-align:middle;}
.mrag-toggle{position:relative;display:inline-block;width:38px;height:20px;flex-shrink:0;}
.mrag-toggle input{opacity:0;width:0;height:0;}
.mrag-slider{position:absolute;inset:0;background:rgba(255,255,255,.15);border-radius:20px;cursor:pointer;transition:background .15s;}
.mrag-slider::before{content:'';position:absolute;width:14px;height:14px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:transform .15s;}
.mrag-toggle input:checked+.mrag-slider{background:#7c6aff;}
.mrag-toggle input:checked+.mrag-slider::before{transform:translateX(18px);}
.mrag-hidden{display:none!important;}
.mrag-stats-panel{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.08);border-radius:4px;padding:10px;margin-top:6px;font-size:11px;max-height:160px;overflow:auto;}
.mrag-stats-panel pre{margin:0;white-space:pre-wrap;word-break:break-word;}

/* ── NEW: Debug console ── */
.mrag-debug-output{background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:8px 10px;margin-top:6px;font-size:11px;max-height:220px;overflow-y:auto;font-family:monospace;line-height:1.55;}

/* ── NEW: Memories viewer ── */
.mrag-mem-list{max-height:340px;overflow-y:auto;margin-top:6px;}
.mrag-mem-item{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:5px;padding:8px 10px;margin-bottom:5px;}
.mrag-mem-item:hover{border-color:rgba(124,106,255,.4);}
.mrag-mem-meta{display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin-bottom:4px;opacity:.6;font-size:10px;}
.mrag-type-badge{padding:1px 6px;border-radius:10px;font-size:9px;font-weight:700;text-transform:uppercase;}
.mrag-type-fact        {background:rgba(160,196,255,.18);color:#a0c4ff;}
.mrag-type-event       {background:rgba(253,202,64,.18);color:#fdca40;}
.mrag-type-emotion     {background:rgba(199,125,255,.18);color:#c77dff;}
.mrag-type-relationship{background:rgba(6,214,160,.18);color:#06d6a0;}
.mrag-mem-text{line-height:1.5;word-break:break-word;font-size:12px;}
.mrag-mem-textarea{width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(124,106,255,.45);border-radius:3px;color:var(--SmartThemeBodyColor,#eee);font-size:12px;padding:4px 7px;resize:vertical;min-height:48px;box-sizing:border-box;}
.mrag-mem-actions{display:flex;gap:5px;margin-top:6px;flex-wrap:wrap;}
.mrag-mbtn{padding:2px 9px;font-size:11px;border-radius:3px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:var(--SmartThemeBodyColor,#eee);cursor:pointer;transition:background .15s;}
.mrag-mbtn:hover{background:rgba(255,255,255,.11);}
.mrag-mbtn--del {border-color:rgba(224,82,82,.4);color:#e05252;}
.mrag-mbtn--del:hover{background:rgba(224,82,82,.14);}
.mrag-mbtn--save{border-color:rgba(6,214,160,.4);color:#06d6a0;}
.mrag-mbtn--save:hover{background:rgba(6,214,160,.14);}
.mrag-mem-empty{opacity:.4;font-size:12px;text-align:center;padding:22px 0;}
.mrag-mem-search{width:100%;margin-bottom:6px;}

/* ── NEW: Scan progress ── */
.mrag-scan-progress{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.08);border-radius:4px;padding:8px 10px;margin-top:8px;font-size:12px;}
.mrag-bar-wrap{width:100%;height:5px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden;margin:5px 0;}
.mrag-bar{height:5px;background:#7c6aff;border-radius:3px;transition:width .2s;width:0%;}
`;
  document.head.appendChild(el);
}

// ════════════════════════════════════════════════════════════
// SETTINGS PANEL HTML
// ════════════════════════════════════════════════════════════

function settingsPanelHTML() {
  const s = cfg();
  return `
<div id="mrag-panel" class="mrag-panel">

  <!-- ── Header ── -->
  <div class="mrag-section">
    <div class="mrag-row mrag-row--spread">
      <span class="mrag-label mrag-label--main">🧠 Memory RAG <span class="mrag-badge" id="mrag-badge">${s.enabled ? 'ON' : 'OFF'}</span></span>
      <label class="mrag-toggle"><input type="checkbox" id="mrag-enabled" ${s.enabled ? 'checked' : ''}><span class="mrag-slider"></span></label>
    </div>
    <p class="mrag-description">Автоматически сохраняет важные события и подключает релевантный контекст к каждому запросу.</p>
  </div>

  <!-- ── Embeddings ── -->
  <details class="mrag-section mrag-collapsible" open>
    <summary class="mrag-summary">⚙️ Embeddings</summary>
    <div class="mrag-body">
      <label class="mrag-label">Провайдер</label>
      <select id="mrag-provider" class="mrag-select">
        <option value="local"  ${s.embeddingProvider === 'local'  ? 'selected' : ''}>🖥 Local (Transformers.js)</option>
        <option value="openai" ${s.embeddingProvider === 'openai' ? 'selected' : ''}>🤖 OpenAI API</option>
        <option value="custom" ${s.embeddingProvider === 'custom' ? 'selected' : ''}>🔌 Custom API</option>
      </select>

      <!-- Local -->
      <div id="mrag-local-opts" class="${s.embeddingProvider === 'local' ? '' : 'mrag-hidden'}">
        <label class="mrag-label">Модель (HuggingFace ID)</label>
        <input type="text" id="mrag-model" class="mrag-input" value="${s.embeddingModel}" placeholder="Xenova/all-MiniLM-L6-v2">
        <p class="mrag-hint">Загружается автоматически. Первый запуск ~20 сек.</p>
      </div>

      <!-- OpenAI -->
      <div id="mrag-openai-opts" class="${s.embeddingProvider === 'openai' ? '' : 'mrag-hidden'}">
        <label class="mrag-label">API Key</label>
        <input type="password" id="mrag-openai-key" class="mrag-input" value="${s.customEmbeddingKey}" placeholder="sk-...">
        <label class="mrag-label">Модель</label>
        <input type="text" id="mrag-openai-model" class="mrag-input" value="${s.customEmbeddingModel || 'text-embedding-3-small'}" placeholder="text-embedding-3-small">
      </div>

      <!-- Custom -->
      <div id="mrag-remote-opts" class="${s.embeddingProvider === 'custom' ? '' : 'mrag-hidden'}">
        <label class="mrag-label">API URL</label>
        <input type="text" id="mrag-custom-url" class="mrag-input" value="${s.customEmbeddingUrl}" placeholder="http://localhost:11434/api/embeddings">
        <label class="mrag-label">API Key (опционально)</label>
        <input type="password" id="mrag-custom-key" class="mrag-input" value="${s.customEmbeddingKey}" placeholder="">
        <label class="mrag-label">Модель (параметр model)</label>
        <input type="text" id="mrag-custom-model" class="mrag-input" value="${s.customEmbeddingModel || ''}" placeholder="nomic-embed-text, mxbai-embed-large…">
        <p class="mrag-hint">Передаётся в тело запроса как <code>model</code>. Для Ollama — обязательно.</p>
      </div>
    </div>
  </details>

  <!-- ── Vector DB ── -->
  <details class="mrag-section mrag-collapsible">
    <summary class="mrag-summary">🗄 Vector Database</summary>
    <div class="mrag-body">
      <label class="mrag-label">Бэкенд</label>
      <select id="mrag-dbtype" class="mrag-select">
        <option value="json"   ${s.vectorDBType === 'json'   ? 'selected' : ''}>📦 JSON / IndexedDB</option>
        <option value="chroma" ${s.vectorDBType === 'chroma' ? 'selected' : ''}>🔵 ChromaDB</option>
        <option value="qdrant" ${s.vectorDBType === 'qdrant' ? 'selected' : ''}>🟠 Qdrant</option>
      </select>
      <div id="mrag-chroma-opts" class="${s.vectorDBType === 'chroma' ? '' : 'mrag-hidden'}">
        <label class="mrag-label">ChromaDB URL</label>
        <input type="text" id="mrag-chroma-url" class="mrag-input" value="${s.chromaUrl}">
      </div>
      <div id="mrag-qdrant-opts" class="${s.vectorDBType === 'qdrant' ? '' : 'mrag-hidden'}">
        <label class="mrag-label">Qdrant URL</label>
        <input type="text" id="mrag-qdrant-url" class="mrag-input" value="${s.qdrantUrl}">
        <label class="mrag-label">API Key</label>
        <input type="password" id="mrag-qdrant-key" class="mrag-input" value="${s.qdrantApiKey}">
      </div>
      <label class="mrag-label">Макс. записей</label>
      <input type="number" id="mrag-max-mem" class="mrag-input" value="${s.maxMemories}" min="50" max="10000">
    </div>
  </details>

  <!-- ── Extraction ── -->
  <details class="mrag-section mrag-collapsible">
    <summary class="mrag-summary">🧠 Извлечение памяти</summary>
    <div class="mrag-body">
      <div class="mrag-row mrag-row--spread">
        <span class="mrag-label" style="margin:0">LLM-классификация</span>
        <label class="mrag-toggle"><input type="checkbox" id="mrag-llm" ${s.llmClassifier ? 'checked' : ''}><span class="mrag-slider"></span></label>
      </div>
      <p class="mrag-hint">Точнее, но добавляет запрос к LLM каждые N сообщений.</p>
      <label class="mrag-label">Каждые N сообщений</label>
      <div class="mrag-row"><input type="range" id="mrag-every" class="mrag-range" value="${s.autoExtractEvery}" min="1" max="10"><span class="mrag-rval" id="mrag-every-v">${s.autoExtractEvery}</span></div>
      <label class="mrag-label">Мин. важность</label>
      <div class="mrag-row"><input type="range" id="mrag-min-imp" class="mrag-range" value="${s.minImportanceScore}" min="0" max="1" step="0.05"><span class="mrag-rval" id="mrag-min-imp-v">${s.minImportanceScore}</span></div>
    </div>
  </details>

  <!-- ── Search & ranking ── -->
  <details class="mrag-section mrag-collapsible">
    <summary class="mrag-summary">🔍 Поиск и ранжирование</summary>
    <div class="mrag-body">
      <label class="mrag-label">Воспоминаний в контексте (topK)</label>
      <div class="mrag-row"><input type="range" id="mrag-topk" class="mrag-range" value="${s.topK}" min="1" max="15"><span class="mrag-rval" id="mrag-topk-v">${s.topK}</span></div>
      <label class="mrag-label">Порог схожести</label>
      <div class="mrag-row"><input type="range" id="mrag-thresh" class="mrag-range" value="${s.similarityThreshold}" min="0.1" max="0.99" step="0.05"><span class="mrag-rval" id="mrag-thresh-v">${s.similarityThreshold}</span></div>
      <label class="mrag-label">Веса: схожесть / важность / свежесть</label>
      <div class="mrag-row"><input type="range" id="mrag-ws" class="mrag-range" value="${s.rankingWeights.similarity}" min="0" max="1" step="0.05"><span class="mrag-rval" id="mrag-ws-v">${s.rankingWeights.similarity}</span></div>
      <div class="mrag-row"><input type="range" id="mrag-wi" class="mrag-range" value="${s.rankingWeights.importance}" min="0" max="1" step="0.05"><span class="mrag-rval" id="mrag-wi-v">${s.rankingWeights.importance}</span></div>
      <div class="mrag-row"><input type="range" id="mrag-wr" class="mrag-range" value="${s.rankingWeights.recency}" min="0" max="1" step="0.05"><span class="mrag-rval" id="mrag-wr-v">${s.rankingWeights.recency}</span></div>
    </div>
  </details>

  <!-- ── Injection ── -->
  <details class="mrag-section mrag-collapsible">
    <summary class="mrag-summary">💉 Инъекция в промпт</summary>
    <div class="mrag-body">
      <label class="mrag-label">Позиция</label>
      <select id="mrag-pos" class="mrag-select">
        <option value="system"       ${s.injectPosition === 'system'       ? 'selected' : ''}>System prompt</option>
        <option value="after_system" ${s.injectPosition === 'after_system' ? 'selected' : ''}>После system prompt</option>
        <option value="before_chat"  ${s.injectPosition === 'before_chat'  ? 'selected' : ''}>Перед историей чата</option>
      </select>
      <label class="mrag-label">Макс. токенов памяти</label>
      <input type="number" id="mrag-maxtok" class="mrag-input" value="${s.maxMemoryTokens}" min="100" max="2000">
    </div>
  </details>

  <!-- ── NEW: Saved memories ── -->
  <details class="mrag-section mrag-collapsible" id="mrag-mem-section">
    <summary class="mrag-summary">📚 Сохранённые воспоминания</summary>
    <div class="mrag-body">
      <input type="text" id="mrag-mem-search" class="mrag-input mrag-mem-search" placeholder="🔎 Поиск по тексту…">
      <div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
        <select id="mrag-mem-filter" class="mrag-select" style="width:auto;flex:1;min-width:120px;">
          <option value="">Все типы</option>
          <option value="fact">📌 Факт</option>
          <option value="event">⚡ Событие</option>
          <option value="emotion">💭 Эмоция</option>
          <option value="relationship">🔗 Отношения</option>
        </select>
        <button id="mrag-mem-refresh" class="menu_button" style="flex-shrink:0;">🔄</button>
      </div>
      <div id="mrag-mem-list" class="mrag-mem-list">
        <div class="mrag-mem-empty">Откройте раздел, чтобы загрузить воспоминания</div>
      </div>
      <div id="mrag-mem-count" style="font-size:10px;opacity:.4;margin-top:4px;text-align:right;"></div>
    </div>
  </details>

  <!-- ── NEW: Scan old chat ── -->
  <details class="mrag-section mrag-collapsible" id="mrag-scan-section">
    <summary class="mrag-summary">🔃 Сканировать старый чат</summary>
    <div class="mrag-body">
      <p class="mrag-hint" style="margin-bottom:8px;">Обрабатывает всю историю текущего чата и создаёт воспоминания из уже написанных сообщений. Дублей не создаёт.</p>
      <div class="mrag-row" style="gap:8px;flex-wrap:wrap;">
        <button id="mrag-btn-scan"      class="menu_button" style="flex:1;">🔍 Начать сканирование</button>
        <button id="mrag-btn-scan-stop" class="menu_button mrag-hidden" style="flex:1;color:#e05252;">⏹ Стоп</button>
      </div>
      <div id="mrag-scan-status" class="mrag-scan-progress mrag-hidden">
        <div id="mrag-scan-text">…</div>
        <div class="mrag-bar-wrap"><div id="mrag-scan-bar" class="mrag-bar"></div></div>
        <div id="mrag-scan-result" style="opacity:.55;font-size:11px;margin-top:2px;"></div>
      </div>
    </div>
  </details>

  <!-- ── Actions ── -->
  <div class="mrag-section mrag-section--actions">
    <button id="mrag-btn-stats"  class="menu_button">📊 Статистика</button>
    <button id="mrag-btn-export" class="menu_button">📤 Экспорт</button>
    <button id="mrag-btn-import" class="menu_button">📥 Импорт</button>
    <button id="mrag-btn-clear"  class="menu_button" style="color:#e05252;">🗑 Очистить</button>
    <div class="mrag-row mrag-row--spread" style="width:100%;margin-top:4px;">
      <span class="mrag-label" style="margin:0">Debug лог</span>
      <label class="mrag-toggle"><input type="checkbox" id="mrag-debug" ${s.debugMode ? 'checked' : ''}><span class="mrag-slider"></span></label>
    </div>
  </div>
  <div id="mrag-stats-out" class="mrag-stats-panel mrag-hidden"></div>

  <!-- ── NEW: Debug console ── -->
  <details class="mrag-section mrag-collapsible" id="mrag-debug-section">
    <summary class="mrag-summary">🖥 Debug консоль</summary>
    <div class="mrag-body" style="padding-top:8px;">
      <div style="display:flex;gap:6px;margin-bottom:4px;">
        <button id="mrag-dbg-clear" class="menu_button" style="font-size:11px;">🗑 Очистить</button>
        <button id="mrag-dbg-copy"  class="menu_button" style="font-size:11px;">📋 Копировать</button>
      </div>
      <div id="mrag-debug-output" class="mrag-debug-output">
        <span style="opacity:.35;font-size:11px;">Лог пуст — события появятся здесь</span>
      </div>
    </div>
  </details>

  <input type="file" id="mrag-import-file" accept=".json" style="display:none">
</div>`;
}

// ════════════════════════════════════════════════════════════
// BIND UI EVENTS
// ════════════════════════════════════════════════════════════

function bindEvents() {
  const $ = id => document.getElementById(id);
  const save = (patch) => { Object.assign(extension_settings[EXT_NAME], patch); saveSettingsDebounced(); };

  const range = (id, valId, key, nested) => {
    const el = $(id), vl = $(valId);
    if (!el || !vl) return;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      vl.textContent = v;
      if (nested) { cfg().rankingWeights[key] = v; save({ rankingWeights: { ...cfg().rankingWeights } }); }
      else save({ [key]: v });
    });
  };

  $('mrag-enabled')?.addEventListener('change', e => {
    save({ enabled: e.target.checked });
    $('mrag-badge').textContent = e.target.checked ? 'ON' : 'OFF';
  });

  // Provider switcher — shows/hides the three option blocks
  $('mrag-provider')?.addEventListener('change', e => {
    const v = e.target.value;
    save({ embeddingProvider: v });
    $('mrag-local-opts').classList.toggle('mrag-hidden',  v !== 'local');
    $('mrag-openai-opts').classList.toggle('mrag-hidden', v !== 'openai');
    $('mrag-remote-opts').classList.toggle('mrag-hidden', v !== 'custom');
    reInitEmbedder();
  });

  $('mrag-model')?.addEventListener('change',       e => { save({ embeddingModel: e.target.value }); reInitEmbedder(); });

  // OpenAI
  $('mrag-openai-key')?.addEventListener('change',   e => save({ customEmbeddingKey: e.target.value }));
  $('mrag-openai-model')?.addEventListener('change', e => save({ customEmbeddingModel: e.target.value }));

  // Custom API (legacy field names kept for compat)
  $('mrag-custom-url')?.addEventListener('change',   e => save({ customEmbeddingUrl: e.target.value }));
  $('mrag-custom-key')?.addEventListener('change',   e => save({ customEmbeddingKey: e.target.value }));
  $('mrag-custom-model')?.addEventListener('change', e => save({ customEmbeddingModel: e.target.value })); // NEW

  $('mrag-dbtype')?.addEventListener('change', e => {
    const v = e.target.value;
    save({ vectorDBType: v });
    $('mrag-chroma-opts').classList.toggle('mrag-hidden', v !== 'chroma');
    $('mrag-qdrant-opts').classList.toggle('mrag-hidden', v !== 'qdrant');
    reInitDB();
  });

  $('mrag-chroma-url')?.addEventListener('change', e => save({ chromaUrl: e.target.value }));
  $('mrag-qdrant-url')?.addEventListener('change', e => save({ qdrantUrl: e.target.value }));
  $('mrag-qdrant-key')?.addEventListener('change', e => save({ qdrantApiKey: e.target.value }));
  $('mrag-max-mem')?.addEventListener('change',    e => save({ maxMemories: parseInt(e.target.value) }));
  $('mrag-llm')?.addEventListener('change',        e => save({ llmClassifier: e.target.checked }));

  range('mrag-every',   'mrag-every-v',   'autoExtractEvery');
  range('mrag-min-imp', 'mrag-min-imp-v', 'minImportanceScore');
  range('mrag-topk',    'mrag-topk-v',    'topK');
  range('mrag-thresh',  'mrag-thresh-v',  'similarityThreshold');
  range('mrag-ws',      'mrag-ws-v',      'similarity', true);
  range('mrag-wi',      'mrag-wi-v',      'importance', true);
  range('mrag-wr',      'mrag-wr-v',      'recency',    true);

  $('mrag-pos')?.addEventListener('change',    e => save({ injectPosition: e.target.value }));
  $('mrag-maxtok')?.addEventListener('change', e => save({ maxMemoryTokens: parseInt(e.target.value) }));
  $('mrag-debug')?.addEventListener('change',  e => save({ debugMode: e.target.checked }));

  $('mrag-btn-stats')?.addEventListener('click', () => {
    const out = $('mrag-stats-out');
    out.innerHTML = '<pre>' + JSON.stringify(vectorDB?.getStats() ?? {}, null, 2) + '</pre>';
    out.classList.toggle('mrag-hidden');
  });

  $('mrag-btn-export')?.addEventListener('click', async () => {
    const data = await vectorDB?.exportAll();
    if (!data) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `memory-rag-${Date.now()}.json`;
    a.click();
  });

  $('mrag-btn-import')?.addEventListener('click', () => $('mrag-import-file').click());
  $('mrag-import-file')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    await vectorDB?.importAll(JSON.parse(await file.text()));
    toastr.success('Память импортирована');
    renderMemoriesList();
  });

  $('mrag-btn-clear')?.addEventListener('click', () => {
    if (confirm('Удалить все воспоминания для текущего персонажа?')) {
      vectorDB?.clear(charId()).then(() => { toastr.info('Память очищена'); renderMemoriesList(); });
    }
  });

  // ── NEW: Saved memories ──
  $('mrag-mem-section')?.addEventListener('toggle', function () { if (this.open) renderMemoriesList(); });
  $('mrag-mem-refresh')?.addEventListener('click', renderMemoriesList);
  $('mrag-mem-search')?.addEventListener('input', renderMemoriesList);
  $('mrag-mem-filter')?.addEventListener('change', renderMemoriesList);

  // ── NEW: Debug console ──
  $('mrag-debug-section')?.addEventListener('toggle', function () {
    if (this.open) _renderDebugLog($('mrag-debug-output'));
  });
  $('mrag-dbg-clear')?.addEventListener('click', () => {
    _debugLog.length = 0;
    const out = $('mrag-debug-output');
    if (out) out.innerHTML = '<span style="opacity:.35;font-size:11px;">Лог очищен</span>';
  });
  $('mrag-dbg-copy')?.addEventListener('click', () => {
    const txt = _debugLog.map(e => `[${e.ts}][${e.level}] ${e.msg}`).join('\n');
    navigator.clipboard?.writeText(txt).then(() => toastr.info('Лог скопирован'));
  });

  // ── NEW: Scan old chat ──
  $('mrag-btn-scan')?.addEventListener('click', scanOldChat);
  $('mrag-btn-scan-stop')?.addEventListener('click', () => { _scanAborted = true; });
}

// ════════════════════════════════════════════════════════════
// NEW: MEMORIES VIEWER — render + edit + delete
// ════════════════════════════════════════════════════════════

function renderMemoriesList() {
  const list    = document.getElementById('mrag-mem-list');
  const counter = document.getElementById('mrag-mem-count');
  if (!list) return;

  const query      = (document.getElementById('mrag-mem-search')?.value ?? '').toLowerCase().trim();
  const filterType = document.getElementById('mrag-mem-filter')?.value ?? '';

  let mems = [...(vectorDB?._memories ?? [])];
  if (filterType) mems = mems.filter(m => m.type === filterType);
  if (query)      mems = mems.filter(m => m.text.toLowerCase().includes(query));
  mems.sort((a, b) => b.timestamp - a.timestamp);

  if (counter) counter.textContent = `${mems.length} воспоминаний`;

  if (!mems.length) {
    list.innerHTML = '<div class="mrag-mem-empty">Воспоминаний не найдено</div>';
    return;
  }

  const ICONS = { fact:'📌', event:'⚡', emotion:'💭', relationship:'🔗' };

  list.innerHTML = mems.map(m => {
    const date = new Date(m.timestamp).toLocaleString('ru', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    const imp  = (m.importance * 100).toFixed(0) + '%';
    const id   = _esc(m.id);
    return `<div class="mrag-mem-item" data-id="${id}">
  <div class="mrag-mem-meta">
    <span class="mrag-type-badge mrag-type-${m.type}">${ICONS[m.type] ?? '•'} ${m.type}</span>
    <span>важность ${imp}</span>
    <span>${date}</span>
  </div>
  <div id="mrag-disp-${id}" class="mrag-mem-text">${_esc(m.text)}</div>
  <textarea id="mrag-edit-${id}" class="mrag-mem-textarea mrag-hidden">${_esc(m.text)}</textarea>
  <div class="mrag-mem-actions">
    <button class="mrag-mbtn" onclick="window._mragToggleEdit('${id}')">✏️ Изменить</button>
    <button id="mrag-savebtn-${id}" class="mrag-mbtn mrag-mbtn--save mrag-hidden" onclick="window._mragSave('${id}')">💾 Сохранить</button>
    <button class="mrag-mbtn mrag-mbtn--del" onclick="window._mragDel('${id}')">🗑 Удалить</button>
  </div>
</div>`;
  }).join('');
}

// Global helpers for inline onclick (needed in ST's sandboxed iframe)
window._mragToggleEdit = function(id) {
  const disp = document.getElementById(`mrag-disp-${id}`);
  const edit = document.getElementById(`mrag-edit-${id}`);
  const btn  = document.getElementById(`mrag-savebtn-${id}`);
  const editing = !edit.classList.contains('mrag-hidden');
  disp.classList.toggle('mrag-hidden', !editing);
  edit.classList.toggle('mrag-hidden', editing);
  btn.classList.toggle('mrag-hidden',  editing);
};

window._mragSave = async function(id) {
  const edit = document.getElementById(`mrag-edit-${id}`);
  const newText = edit?.value?.trim();
  if (!newText) return;
  const mem = vectorDB?._memories.find(m => m.id === id);
  if (!mem) return;
  mem.text = newText;
  try { mem.embedding = await embedder.embed(newText); } catch {}
  await vectorDB._save();
  log(`Воспоминание обновлено: ${id}`);
  toastr.success('Воспоминание обновлено');
  renderMemoriesList();
};

window._mragDel = async function(id) {
  if (!confirm('Удалить это воспоминание?')) return;
  await vectorDB?.deleteMemory(id);
  log(`Воспоминание удалено: ${id}`);
  toastr.info('Воспоминание удалено');
  renderMemoriesList();
};

// ════════════════════════════════════════════════════════════
// NEW: SCAN OLD CHAT
// ════════════════════════════════════════════════════════════

let _scanAborted = false;

async function scanOldChat() {
  const $  = id => document.getElementById(id);
  const btnStart = $('mrag-btn-scan');
  const btnStop  = $('mrag-btn-scan-stop');
  const status   = $('mrag-scan-status');
  const bar      = $('mrag-scan-bar');
  const txt      = $('mrag-scan-text');
  const result   = $('mrag-scan-result');

  let ctx;
  try { ctx = SillyTavern.getContext(); } catch { toastr.error('Нет доступа к контексту SillyTavern'); return; }

  const chat = ctx.chat ?? [];
  if (!chat.length) { toastr.warning('Чат пуст'); return; }

  _scanAborted = false;
  btnStart.classList.add('mrag-hidden');
  btnStop.classList.remove('mrag-hidden');
  status.classList.remove('mrag-hidden');
  result.textContent = '';

  const batchSize = cfg().autoExtractEvery;
  const total = chat.length;
  let stored = 0, processed = 0;

  _pushLog('SCAN', `Начало сканирования — ${total} сообщений, batch=${batchSize}`);

  for (let i = 0; i < total; i += batchSize) {
    if (_scanAborted) { _pushLog('SCAN', 'Остановлено пользователем'); break; }

    const batch = chat.slice(i, i + batchSize);
    processed += batch.length;

    const pct = Math.round((processed / total) * 100);
    bar.style.width = pct + '%';
    txt.textContent = `Сообщения ${i + 1}–${Math.min(i + batchSize, total)} из ${total}…`;

    try {
      const found = await extractor.extract(batch);
      const s = cfg();
      for (const e of found) {
        if (e.importance < s.minImportanceScore) continue;
        // Simple dedup by text
        if (vectorDB._memories.some(m => m.text === e.text)) continue;
        const embedding = await embedder.embed(e.text);
        await vectorDB.addMemory({ id: genId(), text: e.text, embedding, type: e.type, importance: e.importance, timestamp: Date.now() });
        stored++;
        _pushLog('SCAN', `[${e.type}] imp=${e.importance.toFixed(2)} — ${e.text.slice(0, 80)}`);
      }
    } catch (err) { logErr('Scan batch error:', err.message); }

    await new Promise(r => setTimeout(r, 0)); // yield to browser
  }

  btnStart.classList.remove('mrag-hidden');
  btnStop.classList.add('mrag-hidden');
  bar.style.width = '100%';
  txt.textContent = _scanAborted ? '⏹ Остановлено' : '✅ Готово';
  result.textContent = `Добавлено: ${stored} воспоминаний`;

  _pushLog('SCAN', `Завершено. Сохранено: ${stored}`);
  toastr.success(`Сканирование завершено. Добавлено воспоминаний: ${stored}`);
  renderMemoriesList();
}

// ════════════════════════════════════════════════════════════
// MEMORY EXTRACTOR
// ════════════════════════════════════════════════════════════

class MemoryExtractor {
  async extract(messages) {
    const s = cfg();
    if (s.llmClassifier) {
      try {
        const result = await this._extractLLM(messages);
        if (Array.isArray(result) && result.length > 0) return result;
        logWarn('LLM extraction returned empty, using heuristic');
      } catch (e) {
        // Log every available property so the real cause is always visible
        const detail = e instanceof Error
          ? (e.message || '(empty message)') + (e.cause ? ' | cause: ' + e.cause : '')
          : (typeof e === 'object' ? JSON.stringify(e) : String(e));
        logWarn('LLM extraction failed (' + detail + ') — using heuristic');
      }
    }
    return this._extractHeuristic(messages);
  }

  async _extractLLM(messages) {
    const conversation = messages
      .filter(m => !m.is_system && m.mes)
      .map(m => `${m.is_user ? 'User' : 'AI'}: ${m.mes}`)
      .join('\n');

    if (!conversation.trim()) return [];

    const prompt = `Extract 1-3 important memory entries from this conversation. Only factual events, character facts, relationship changes, emotional moments.
Respond ONLY with JSON array (no markdown): [{"text":"...","type":"fact|event|emotion|relationship","importance":0.0-1.0}]
If nothing important: []

Conversation:
${conversation}`;

    let raw = '';

    // ── Method 1: SillyTavern built-in quiet generate ──
    try {
      const ctx = SillyTavern.getContext();
      if (typeof ctx.generateQuietPrompt !== 'function') throw new Error('generateQuietPrompt not available');
      _pushLog('INFO', 'LLM extract: generateQuietPrompt…');
      raw = await Promise.race([
        ctx.generateQuietPrompt(prompt, false, false),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 30s')), 30000)),
      ]) ?? '';
      _pushLog('INFO', 'generateQuietPrompt OK, got ' + raw.length + ' chars');
    } catch (e) {
      _pushLog('WARN', 'generateQuietPrompt: ' + (e?.message || String(e)));
    }

    // ── Method 2: REST endpoints ──
    if (!raw) {
      const endpoints = [
        '/api/backends/chat-completions/generate',
        '/api/completions/generate',
        '/generate',
      ];
      for (const ep of endpoints) {
        try {
          _pushLog('INFO', 'LLM extract REST: ' + ep);
          const res = await fetch(ep, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, max_new_tokens: 512, temperature: 0.3, stream: false }),
          });
          _pushLog('INFO', ep + ' → HTTP ' + res.status);
          if (res.ok) {
            const d = await res.json();
            raw = d.results?.[0]?.text ?? d.choices?.[0]?.text ?? d.output ?? d.content ?? '';
            if (raw) break;
          }
        } catch (fe) {
          _pushLog('WARN', ep + ' error: ' + (fe?.message || String(fe)));
        }
      }
    }

    if (!raw) throw new Error('No response from LLM — all methods failed');

    // ── Parse JSON ──
    const clean = raw.replace(/```json|```/g, '').trim();
    const match  = clean.match(/\[[\s\S]*?\]/);
    if (!match) {
      _pushLog('WARN', 'LLM gave no JSON array. Response: ' + clean.slice(0, 120));
      return [];
    }
    try {
      const arr = JSON.parse(match[0]);
      return Array.isArray(arr) ? arr.filter(e => e.text && e.type).map(e => ({
        text: e.text.trim(),
        type: this._type(e.type),
        importance: Math.min(1, Math.max(0, e.importance ?? 0.5)),
      })) : [];
    } catch (pe) {
      _pushLog('WARN', 'JSON parse error: ' + pe.message + ' | raw: ' + match[0].slice(0, 80));
      return [];
    }
  }

  _extractHeuristic(messages) {
    const results = [];
    for (const msg of messages) {
      if (msg.is_system || !msg.mes) continue;
      const score = this.quickScore(msg.mes);
      if (score < cfg().minImportanceScore) continue;

      // Split on sentence boundaries (both Latin and Cyrillic punctuation)
      const sentences = msg.mes
        .split(/(?<=[.!?…])\s+|(?<=[\u0021\u003F\u2026])\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 10);

      if (!sentences.length) {
        // Message too short for splitting — store as-is if it passes score
        const trimmed = msg.mes.trim();
        if (trimmed.length > 10)
          results.push({ text: trimmed.slice(0, 300), type: this.classifyType(trimmed), importance: score });
        continue;
      }

      let added = 0;
      for (const s of sentences) {
        if (added >= 2) break;
        const ss = this.quickScore(s);
        if (ss >= cfg().minImportanceScore) {
          results.push({ text: s.slice(0, 300), type: this.classifyType(s), importance: ss });
          added++;
        }
      }
      // If no sentence passed individually but whole message did, store best sentence
      if (added === 0 && sentences.length) {
        const best = sentences.reduce((a, b) => this.quickScore(a) >= this.quickScore(b) ? a : b);
        results.push({ text: best.slice(0, 300), type: this.classifyType(best), importance: score });
      }
    }
    return results.slice(0, 5);
  }

  quickScore(text) {
    if (!text) return 0;
    let score = 0.15; // raised base so more messages pass threshold
    const lower = text.toLowerCase();
    const words  = text.split(/\s+/).length;

    if (words > 15) score += 0.08;
    if (words > 40) score += 0.08;

    // English signals
    const enSignals = [
      'killed','died','dead','murder','found','discovered','betrayed','promised','revealed','confessed',
      'love','hate','fear','trust','friend','enemy','ally','lover','named','called',
      'my name','my secret','my past','my goal','my family','arrived','escaped','left','attacked',
    ];
    // Russian signals
    const ruSignals = [
      'убил','убили','умер','умерла','нашёл','нашли','предал','предала','обещал','признался','призналась',
      'люблю','ненавижу','боюсь','доверяю','друг','враг','союзник','возлюбленн','зовут','называют',
      'моё имя','мой секрет','моё прошлое','моя цель','моя семья','прибыл','сбежал','ушёл','напал',
      'меня зовут','я помню','я знаю','ты знаешь','мы были',
    ];

    const allSignals = [...enSignals, ...ruSignals];
    score += Math.min(0.45, allSignals.filter(s => lower.includes(s)).length * 0.08);

    // English patterns
    if (/\bI (am|will|won't|can't|must|was|have been)\b/i.test(text)) score += 0.08;
    if (/\bmy (name|goal|secret|past|family|home|power|weakness)\b/i.test(text)) score += 0.12;
    // Russian patterns
    if (/\b(я|мне|меня|мой|моя|моё|мои)\b/i.test(text)) score += 0.05;
    if (/\b(всегда|никогда|впервые|навсегда|потому что|поэтому)\b/i.test(text)) score += 0.05;

    return Math.min(1.0, score);
  }

  classifyType(text) {
    const l = text.toLowerCase();
    // Relationship — EN + RU
    if (/\b(friend|enemy|ally|lover|partner|hate|love|trust|betray|друг|враг|союзник|люб|ненавид|доверя|предал)\b/.test(l)) return 'relationship';
    // Emotion — EN + RU
    if (/\b(feel|felt|cry|tears|angry|sad|happy|afraid|joy|hurt|чувству|плачу|злой|грустн|счастлив|боюсь|боль|страх|радост)\b/.test(l)) return 'emotion';
    // Event — EN + RU
    if (/\b(killed|died|found|discovered|arrived|attacked|escaped|left|came|убил|умер|нашёл|прибыл|напал|сбежал|ушёл|пришёл)\b/.test(l)) return 'event';
    return 'fact';
  }

  _type(raw) {
    return { fact:'fact', event:'event', emotion:'emotion', emotional:'emotion', relationship:'relationship' }[raw?.toLowerCase()] ?? 'fact';
  }
}

// ════════════════════════════════════════════════════════════
// EMBEDDING MODULE
// ════════════════════════════════════════════════════════════

class EmbeddingModule {
  constructor() { this._pipeline = null; this._cache = new Map(); }

  async init() {
    const s = cfg();
    if (s.embeddingProvider !== 'local') return;
    try {
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js');
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      log('Loading embedding model:', s.embeddingModel);
      this._pipeline = await pipeline('feature-extraction', s.embeddingModel, { quantized: true });
      log('Embedding model ready ✓');
    } catch (e) {
      logErr('Model load failed:', e.message);
      toastr.warning('Memory RAG: не удалось загрузить модель embeddings. Используется заглушка.', 'Memory RAG');
    }
  }

  async embed(text) {
    const key = text.trim().slice(0, 512);
    if (this._cache.has(key)) return this._cache.get(key);
    const s = cfg();
    let v;
    try {
      switch (s.embeddingProvider) {
        case 'local':  v = await this._local(key);  break;
        case 'openai': v = await this._openai(key); break;
        case 'custom': v = await this._custom(key); break;
        default:       v = await this._local(key);
      }
    } catch (e) {
      logWarn('Embed error, using random vector:', e.message);
      v = this._random(s.embeddingDimension ?? 384);
    }
    if (this._cache.size > 200) this._cache.delete(this._cache.keys().next().value);
    this._cache.set(key, v);
    return v;
  }

  async _local(text) {
    if (!this._pipeline) return this._random(cfg().embeddingDimension ?? 384);
    const out = await this._pipeline(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  }

  async _openai(text) {
    const s = cfg();
    // NEW: use customEmbeddingModel if set, fallback to embeddingModel then default
    const model = s.customEmbeddingModel || s.embeddingModel || 'text-embedding-3-small';
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.customEmbeddingKey}` },
      body: JSON.stringify({ model, input: text }),
    });
    if (!res.ok) throw new Error('OpenAI HTTP ' + res.status);
    return (await res.json()).data[0].embedding;
  }

  async _custom(text) {
    const s = cfg();
    const headers = { 'Content-Type': 'application/json' };
    if (s.customEmbeddingKey) headers['Authorization'] = `Bearer ${s.customEmbeddingKey}`;

    // NEW: include model name in request body when specified
    const body = { input: text };
    if (s.customEmbeddingModel) body.model = s.customEmbeddingModel;

    log(`Custom embed → ${s.customEmbeddingUrl}  model=${s.customEmbeddingModel || '(не задана)'}`);
    const res = await fetch(s.customEmbeddingUrl, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('Custom API HTTP ' + res.status);
    const d = await res.json();
    // Support multiple response shapes (OpenAI, Ollama, raw array)
    return d.embedding ?? d.data?.[0]?.embedding ?? d.embeddings?.[0] ?? d;
  }

  _random(dim) { return Array.from({ length: dim }, () => Math.random() * 2 - 1); }

  static cosine(a, b) {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
  }
}

// ════════════════════════════════════════════════════════════
// VECTOR DB  (JSON + IndexedDB)
// ════════════════════════════════════════════════════════════

class VectorDB {
  constructor() { this._memories = []; this._key = 'default'; }

  async init(cid) {
    this._key = `mrag:${cid}`;
    this._memories = await this._load() ?? [];
    log('VectorDB loaded:', this._memories.length, 'memories');
  }

  async switchNamespace(cid) {
    await this._save();
    this._key = `mrag:${cid}`;
    this._memories = await this._load() ?? [];
  }

  async addMemory(entry) {
    const s = cfg();
    if (this._memories.length >= s.maxMemories) this._evict();
    this._memories.push(entry);
    await this._save();
  }

  async search(qEmb, topK, threshold) {
    if (!this._memories.length) return [];
    const now = Date.now(), maxAge = 30*24*60*60*1000;
    const w = cfg().rankingWeights;
    return this._memories
      .map(m => {
        const sim = EmbeddingModule.cosine(qEmb, m.embedding);
        if (sim < threshold) return null;
        const recency = 1 - Math.min(1, (now - m.timestamp) / maxAge);
        return { ...m, _score: sim * w.similarity + m.importance * w.importance + recency * w.recency, _sim: sim };
      })
      .filter(Boolean)
      .sort((a, b) => b._score - a._score)
      .slice(0, topK);
  }

  async deleteMemory(id) { this._memories = this._memories.filter(m => m.id !== id); await this._save(); }
  async clear()          { this._memories = []; await this._save(); }

  getStats() {
    const byType = {};
    for (const m of this._memories) byType[m.type] = (byType[m.type] ?? 0) + 1;
    return { total: this._memories.length, byType, backend: 'IndexedDB', namespace: this._key };
  }

  async exportAll() { return JSON.parse(JSON.stringify(this._memories)); }
  async importAll(data) { this._memories = data; await this._save(); }

  _evict() {
    this._memories.sort((a, b) => a.importance !== b.importance ? a.importance - b.importance : a.timestamp - b.timestamp);
    this._memories.shift();
  }

  _openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('mrag-db', 1);
      r.onupgradeneeded = e => { if (!e.target.result.objectStoreNames.contains('m')) e.target.result.createObjectStore('m'); };
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  }

  async _save() {
    try {
      const db = await this._openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction('m', 'readwrite');
        tx.objectStore('m').put(this._memories, this._key);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (e) { logWarn('DB save error:', e.message); }
  }

  async _load() {
    try {
      const db = await this._openDB();
      return await new Promise((res, rej) => {
        const tx = db.transaction('m', 'readonly');
        const r  = tx.objectStore('m').get(this._key);
        r.onsuccess = () => res(r.result ?? []); r.onerror = () => rej(r.error);
      });
    } catch { return []; }
  }
}

// ════════════════════════════════════════════════════════════
// PROMPT INJECTOR
// ════════════════════════════════════════════════════════════

function buildMemoryBlock(memories) {
  const icons = { fact:'📌', event:'⚡', emotion:'💭', relationship:'🔗' };
  const s = cfg();
  const budget = s.maxMemoryTokens * 4;
  let total = 0;
  const lines = [];
  for (const m of memories) {
    const line = `${icons[m.type] ?? '•'} ${m.text}`;
    if (total + line.length > budget) break;
    lines.push(line); total += line.length;
  }
  return lines.length ? s.memoryHeader + lines.join('\n') + '\n' : null;
}

function injectMemories(data, memories) {
  const block = buildMemoryBlock(memories);
  if (!block) return;

  const pos = cfg().injectPosition;

  if (data.messages?.length) {
    if (pos === 'before_chat') {
      const idx = data.messages.findIndex(m => m.role !== 'system');
      if (idx >= 0) { data.messages.splice(idx, 0, { role: 'system', content: block }); return; }
    }
    if (pos === 'after_system') {
      let last = -1;
      for (let i = 0; i < data.messages.length; i++) { if (data.messages[i].role === 'system') last = i; else break; }
      if (last >= 0) { data.messages.splice(last + 1, 0, { role: 'system', content: block }); return; }
    }
    const sys = data.messages.find(m => m.role === 'system');
    if (sys) { sys.content += '\n\n' + block; return; }
    data.messages.unshift({ role: 'system', content: block });
    return;
  }

  if (typeof data.prompt === 'string') { data.prompt = block + '\n' + data.prompt; }
}

// ════════════════════════════════════════════════════════════
// STATE & HELPERS
// ════════════════════════════════════════════════════════════

let extractor = new MemoryExtractor();
let embedder  = new EmbeddingModule();
let vectorDB  = new VectorDB();
let msgCount  = 0;

function charId() {
  try {
    const ctx = SillyTavern.getContext();
    return String(ctx.characterId ?? ctx.groupId ?? 'default');
  } catch { return 'default'; }
}

function genId() { return `m_${Date.now()}_${Math.random().toString(36).slice(2,8)}`; }

async function reInitEmbedder() { embedder = new EmbeddingModule(); await embedder.init(); }
async function reInitDB()       { vectorDB = new VectorDB(); await vectorDB.init(charId()); }

// ════════════════════════════════════════════════════════════
// EVENT HOOKS
// ════════════════════════════════════════════════════════════

async function onBeforePrompt(data) {
  if (!cfg()?.enabled || data._skipMemoryRAG) return;
  try {
    const ctx = SillyTavern.getContext();
    let lastMsg = null;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
      if (ctx.chat[i].is_user && !ctx.chat[i].is_system) { lastMsg = ctx.chat[i].mes; break; }
    }
    if (!lastMsg) return;
    const qEmb = await embedder.embed(lastMsg);
    const s = cfg();
    const mems = await vectorDB.search(qEmb, s.topK, s.similarityThreshold);
    if (!mems.length) { log('No memories found'); return; }
    injectMemories(data, mems);
    // NEW: detailed debug log for each injected memory
    _pushLog('INJECT', `Инжектировано ${mems.length}: ${mems.map(m => `"${m.text.slice(0,40)}" (sim=${m._sim?.toFixed(2)})`).join(' | ')}`);
  } catch (e) { logErr('onBeforePrompt:', e.message); }
}

async function onMessageReceived(msgId) {
  if (!cfg()?.enabled) return;
  try {
    const ctx = SillyTavern.getContext();
    if (!ctx.chat[msgId]) return;
    msgCount++;
    const s = cfg();
    if (msgCount % s.autoExtractEvery !== 0) return;
    const start = Math.max(0, msgId - s.autoExtractEvery + 1);
    const msgs  = ctx.chat.slice(start, msgId + 1);
    const found = await extractor.extract(msgs);
    for (const e of found) {
      if (e.importance < s.minImportanceScore) continue;
      const embedding = await embedder.embed(e.text);
      await vectorDB.addMemory({ id: genId(), text: e.text, embedding, type: e.type, importance: e.importance, timestamp: Date.now() });
      // NEW: log to debug console
      _pushLog('STORED', `[${e.type}] imp=${e.importance.toFixed(2)} — ${e.text.slice(0, 80)}`);
      log(`Stored [${e.type}] ${e.importance.toFixed(2)} — ${e.text.slice(0, 60)}`);
    }
  } catch (e) { logErr('onMessageReceived:', e.message); }
}

async function onChatChanged() {
  try { await vectorDB.switchNamespace(charId()); msgCount = 0; log('Namespace switched:', charId()); }
  catch (e) { logErr('onChatChanged:', e.message); }
}

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════

jQuery(async () => {
  try {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = structuredClone(defaultSettings);
    for (const [k, v] of Object.entries(defaultSettings)) {
      if (extension_settings[EXT_NAME][k] === undefined) extension_settings[EXT_NAME][k] = v;
    }
    if (!extension_settings[EXT_NAME].rankingWeights) {
      extension_settings[EXT_NAME].rankingWeights = { ...defaultSettings.rankingWeights };
    }

    injectStyles();
    $('#extensions_settings').append(settingsPanelHTML());
    bindEvents();

    await embedder.init();
    await vectorDB.init(charId());

    eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, onBeforePrompt);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    window.MemoryRAG = {
      getStats:       ()     => vectorDB.getStats(),
      clearMemories:  ()     => vectorDB.clear(),
      exportMemories: ()     => vectorDB.exportAll(),
      importMemories: (data) => vectorDB.importAll(data),
      searchMemories: async (q) => { const e = await embedder.embed(q); return vectorDB.search(e, 10, 0); },
      getLog:         ()     => _debugLog.map(e => `[${e.ts}][${e.level}] ${e.msg}`).join('\n'),
    };

    log('✅ Memory RAG v2.0 инициализирован');
    console.log('[MemoryRAG] ✅ Ready v2.0');
  } catch (e) {
    console.error('[MemoryRAG] Init error:', e);
    try { toastr.error('Memory RAG: ошибка инициализации — ' + e.message); } catch {}
  }
});
