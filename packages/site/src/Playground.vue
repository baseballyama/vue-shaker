<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { shake, type ShakeOutput, type Files } from './engine';
import { presets, clonePresetFiles, type Preset } from './presets';

const activePreset = ref<Preset>(presets[0]!);
const files = ref<Files>(clonePresetFiles(presets[0]!));
const activeFile = ref<string>(presets[0]!.entry);
const result = ref<ShakeOutput | null>(null);
const running = ref(false);

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
  activeFile.value = p.entry;
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

const shakenActive = computed<string>(() => {
  const out = result.value?.shaken[activeFile.value];
  return out ?? files.value[activeFile.value] ?? '';
});

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
        <textarea
          class="code input"
          spellcheck="false"
          :value="files[activeFile]"
          @input="onInput"
          @keydown="onTab"
        />
      </div>

      <div class="col">
        <div class="col-head">
          <span class="col-title">Shaken</span>
          <span class="col-sub">
            <template v-if="running">shaking…</template>
            <template v-else-if="result?.error" class="err">parse error</template>
            <template v-else>output · read-only</template>
          </span>
        </div>
        <textarea
          class="code output"
          :class="{ dim: running }"
          spellcheck="false"
          readonly
          :value="result?.error ? '⚠ ' + result.error : shakenActive"
        />
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
.code {
  width: 100%;
  height: clamp(320px, 46vh, 540px);
  resize: vertical;
  border: none;
  outline: none;
  padding: 16px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  line-height: 1.65;
  tab-size: 2;
  white-space: pre;
  overflow: auto;
}
.code.input:focus {
  background: rgba(66, 184, 131, 0.03);
}
.code.output {
  color: var(--ink-dim);
  background: var(--bg-2);
}
.code.dim {
  opacity: 0.5;
  transition: opacity 0.15s ease;
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
