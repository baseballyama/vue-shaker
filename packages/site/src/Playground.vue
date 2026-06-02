<script setup lang="ts">
import { ref, computed, watch, onUnmounted, onMounted } from 'vue';
import { shake, type ShakeOutput, type Files } from './engine';
import { presets, clonePresetFiles, type Preset } from './presets';
import { loadHighlighter, tokenize, diffRows, type CodeHighlighter } from './highlight';

const activePreset = ref<Preset>(presets[0]!);
const files = ref<Files>(clonePresetFiles(presets[0]!));
// Show the file where the shake is most visible first (falls back to entry).
const activeFile = ref<string>(presets[0]!.focus ?? presets[0]!.entry);
const result = ref<ShakeOutput | null>(null);
const running = ref(false);

const hl = ref<CodeHighlighter | null>(null);
onMounted(async () => {
  hl.value = await loadHighlighter();
});

const fileNames = computed(() => Object.keys(files.value));

/** Strip the leading `/` for nicer tab labels. */
function label(id: string): string {
  return id.replace(/^\//, '');
}

function loadPreset(id: string): void {
  const p = presets.find((x) => x.id === id);
  if (!p) return;
  activePreset.value = p;
  files.value = clonePresetFiles(p);
  activeFile.value = p.focus ?? p.entry;
}

function onInput(e: Event): void {
  const value = (e.target as HTMLTextAreaElement).value;
  files.value = { ...files.value, [activeFile.value]: value };
}

// Insert two spaces on Tab instead of moving focus.
function onTab(e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const ta = e.currentTarget as HTMLTextAreaElement;
  const s = ta.selectionStart;
  const next = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
  files.value = { ...files.value, [activeFile.value]: next };
  requestAnimationFrame(() => {
    ta.selectionStart = ta.selectionEnd = s + 2;
  });
}

// Keep the highlighted overlay scrolled in lockstep with the textarea.
const taEl = ref<HTMLTextAreaElement>();
const hlEl = ref<HTMLElement>();
function syncScroll(): void {
  if (hlEl.value && taEl.value) {
    hlEl.value.scrollTop = taEl.value.scrollTop;
    hlEl.value.scrollLeft = taEl.value.scrollLeft;
  }
}

// Debounced (~200ms) re-shake on every source change — fully client-side.
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  files,
  (snapshot) => {
    running.value = true;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      result.value = await shake({ ...snapshot }, activePreset.value.entry);
      running.value = false;
    }, 200);
  },
  { immediate: true, deep: true },
);

onUnmounted(() => clearTimeout(timer));

const source = computed<string>(() => files.value[activeFile.value] ?? '');
const shakenActive = computed<string>(
  () => result.value?.shaken[activeFile.value] ?? source.value,
);

/** Highlighted tokens for the editor overlay (null until Shiki has loaded). */
const inputLines = computed(() => (hl.value ? tokenize(hl.value, source.value) : null));

/** The "what was shaken" diff for the active file. */
const diff = computed(() =>
  hl.value && !result.value?.error ? diffRows(hl.value, source.value, shakenActive.value) : null,
);

const removedLines = computed(() => diff.value?.filter((r) => r.kind === 'del').length ?? 0);

const changedFiles = computed<Set<string>>(() => {
  const set = new Set<string>();
  const r = result.value;
  if (!r) return set;
  for (const id of fileNames.value) {
    const after = r.shaken[id];
    if (after !== undefined && after !== files.value[id]) set.add(id);
  }
  return set;
});

const savedPct = computed<number>(() => {
  const r = result.value;
  if (!r || r.before === 0) return 0;
  return Math.max(0, Math.round(((r.before - r.after) / r.before) * 100));
});

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;
}
</script>

<template>
  <div class="pg">
    <div class="toolbar">
      <label class="preset">
        <span class="lbl">Example</span>
        <select :value="activePreset.id" @change="loadPreset(($event.target as HTMLSelectElement).value)">
          <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <p class="blurb">{{ activePreset.blurb }}</p>
    </div>

    <div class="tabs">
      <button
        v-for="name in fileNames"
        :key="name"
        class="tab"
        :class="{ active: name === activeFile, changed: changedFiles.has(name) }"
        type="button"
        @click="activeFile = name"
      >
        {{ label(name) }}
        <span v-if="changedFiles.has(name)" class="dot" title="shaken" />
      </button>
    </div>

    <div class="cols">
      <div class="col">
        <div class="col-head">
          <span class="col-title">Source</span>
          <span class="col-sub">{{ label(activeFile) }} · editable</span>
        </div>
        <div class="editor">
          <pre ref="hlEl" class="hl" aria-hidden="true"><code><div
            v-for="(line, i) in inputLines"
            :key="i"
            class="ln"
          ><span v-for="(t, k) in line" :key="k" :style="{ color: t.color }">{{ t.content }}</span><span v-if="!line.length">&#8203;</span></div></code></pre>
          <textarea
            ref="taEl"
            class="code input"
            :class="{ raw: !inputLines }"
            spellcheck="false"
            :value="source"
            @input="onInput"
            @keydown="onTab"
            @scroll="syncScroll"
          />
        </div>
      </div>

      <div class="col">
        <div class="col-head">
          <span class="col-title">Shaken</span>
          <span class="col-sub">
            <template v-if="running">shaking…</template>
            <template v-else-if="result?.error">⚠ parse error</template>
            <template v-else-if="removedLines > 0">{{ removedLines }} lines removed ·
              <span class="legend"><i class="sw del" />removed</span></template>
            <template v-else>no change</template>
          </span>
        </div>

        <pre v-if="result?.error" class="code output err">⚠ {{ result.error }}</pre>
        <div v-else-if="diff" class="diff" :class="{ dim: running }">
          <div v-for="(row, i) in diff" :key="i" class="row" :class="row.kind">
            <span class="g">{{ row.kind === 'del' ? '-' : row.kind === 'add' ? '+' : '' }}</span>
            <code class="ln"><span
              v-for="(t, k) in row.line"
              :key="k"
              :style="{ color: t.color }"
            >{{ t.content }}</span><span v-if="!row.line.length">&#8203;</span></code>
          </div>
        </div>
        <pre v-else class="code output">{{ shakenActive }}</pre>
      </div>
    </div>

    <div class="stats">
      <div class="stat">
        <span class="k">Before</span>
        <span class="v">{{ bytes(result?.before ?? 0) }}</span>
      </div>
      <div class="arrow">→</div>
      <div class="stat">
        <span class="k">After</span>
        <span class="v">{{ bytes(result?.after ?? 0) }}</span>
      </div>
      <div class="stat saved" :class="{ on: savedPct > 0 }">
        <span class="k">Saved</span>
        <span class="v">{{ savedPct }}%</span>
      </div>
      <div class="spacer" />
      <div class="chips">
        <span class="chip" :class="{ on: (result?.eliminated.props ?? 0) > 0 }">
          {{ result?.eliminated.props ?? 0 }} props folded
        </span>
        <span class="chip" :class="{ on: (result?.eliminated.vIf ?? 0) > 0 }">
          {{ result?.eliminated.vIf ?? 0 }} v-if removed
        </span>
        <span class="chip" :class="{ on: (result?.eliminated.cssRules ?? 0) > 0 }">
          {{ result?.eliminated.cssRules ?? 0 }} CSS rules
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pg {
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--panel);
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.preset {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.preset .lbl {
  font-size: 12px;
  color: var(--ink-faint);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.preset select {
  background: var(--bg-2);
  color: var(--ink);
  border: 1px solid var(--line-2);
  border-radius: 7px;
  padding: 6px 10px;
  font-size: 13px;
  font-weight: 600;
}
.preset select:focus-visible {
  outline: 2px solid var(--accent);
}
.blurb {
  margin: 0;
  flex: 1;
  min-width: 280px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-dim);
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 0 10px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
}
.tab {
  position: relative;
  background: transparent;
  border: none;
  color: var(--ink-faint);
  font-family: var(--mono);
  font-size: 12.5px;
  padding: 11px 14px;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}
.tab:hover {
  color: var(--ink-dim);
}
.tab.active {
  color: var(--ink);
  border-bottom-color: var(--accent);
}
.tab .dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  margin-left: 6px;
  vertical-align: middle;
}

.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.col + .col {
  border-left: 1px solid var(--line);
}
.col-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
}
.col-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.col-sub {
  font-size: 11.5px;
  color: var(--ink-faint);
  font-family: var(--mono);
}
.legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.legend .sw {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
}
.legend .sw.del {
  background: var(--del-bg);
  border: 1px solid var(--del);
}

/* ---- shared code metrics (editor + diff must match exactly) ---- */
.editor,
.code,
.diff {
  height: clamp(340px, 52vh, 600px);
}
.code,
.hl,
.diff .ln,
.diff .row {
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.65;
  tab-size: 2;
}

/* ---- editor: transparent textarea over a highlighted <pre> ---- */
.editor {
  position: relative;
  resize: vertical;
  overflow: hidden;
}
.editor .hl {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 16px;
  overflow: auto;
  pointer-events: none;
  white-space: pre;
  background: var(--panel);
}
.editor .hl .ln {
  display: block;
  min-height: 1.65em;
}
.editor .code.input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 16px;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: transparent;
  caret-color: var(--accent);
  white-space: pre;
  overflow: auto;
}
/* Before Shiki loads, show plain readable text instead of a blank box. */
.editor .code.input.raw {
  color: var(--ink);
}
.editor .code.input:focus {
  background: rgba(66, 184, 131, 0.03);
}

/* ---- diff (shaken) output ---- */
.diff {
  overflow: auto;
  background: var(--bg-2);
  padding: 16px 0;
}
.diff.dim {
  opacity: 0.5;
  transition: opacity 0.15s ease;
}
.diff .row {
  display: flex;
  white-space: pre;
  min-height: 1.65em;
}
.diff .row .g {
  flex: 0 0 22px;
  text-align: center;
  color: var(--ink-faint);
  user-select: none;
}
.diff .row .ln {
  white-space: pre;
}
.diff .row.del {
  background: var(--del-bg);
}
.diff .row.del .g {
  color: var(--del);
}
.diff .row.del .ln {
  opacity: 0.85;
}
.diff .row.add {
  background: var(--add-bg);
}
.diff .row.add .g {
  color: var(--add);
}

.code.output {
  width: 100%;
  margin: 0;
  padding: 16px;
  background: var(--bg-2);
  color: var(--ink-dim);
  white-space: pre;
  overflow: auto;
}
.code.output.err {
  color: var(--del);
}

.stats {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-1);
  flex-wrap: wrap;
}
.stat {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.stat .k {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
}
.stat .v {
  font-family: var(--mono);
  font-size: 16px;
  font-weight: 700;
}
.stat.saved .v {
  color: var(--ink-faint);
}
.stat.saved.on .v {
  color: var(--accent);
}
.arrow {
  color: var(--ink-faint);
  font-size: 18px;
}
.spacer {
  flex: 1;
}
.chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.chip {
  font-family: var(--mono);
  font-size: 11.5px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--line-2);
  color: var(--ink-faint);
  background: var(--bg-2);
}
.chip.on {
  color: var(--accent-2);
  border-color: var(--accent);
  background: var(--accent-bg);
}

@media (max-width: 720px) {
  .cols {
    grid-template-columns: 1fr;
  }
  .col + .col {
    border-left: none;
    border-top: 1px solid var(--line);
  }
}
</style>
