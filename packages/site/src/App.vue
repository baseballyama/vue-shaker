<script setup lang="ts">
import Playground from './Playground.vue';

// Respect the deploy base path (`/` locally, `/vue-shaker/` on GH Pages).
const iconUrl = `${import.meta.env.BASE_URL}vue-shaker.png`;
</script>

<template>
  <main>
    <header class="hero">
      <img class="logo" :src="iconUrl" alt="vue-shaker logo" width="120" height="120" />
      <div class="hero-text">
        <div class="eyebrow">whole-program · source-level · Vue 3</div>
        <h1>vue-shaker</h1>
        <p class="tagline">Deletes the dead code your bundler can't see.</p>
        <p class="lede">
          Rollup tree-shakes JS modules — but it can't see inside a
          <code>.vue</code>, and Vue compiles one generic render function per
          component and prunes <em>no</em> CSS at all. So the
          <code>.btn-danger</code> rule you never use, the
          <code>v-if="loading"</code> spinner you never trigger, and the props
          you never pass all ship — in <em>every</em> app that imports the
          component. <strong>vue-shaker</strong> partial-evaluates each
          <code>.vue</code> against how your <em>whole app</em> actually calls
          it and removes what can never run — <em>before</em> the Vue compiler
          sees it.
        </p>
        <ul class="diffs">
          <li>
            <span class="x">Rollup / terser</span> can't read the runtime class
            strings or template branches inside a <code>.vue</code>
          </li>
          <li>
            <span class="x">Vue's compiler</span> emits every
            <code>&lt;style scoped&gt;</code> rule, used or not
          </li>
          <li>
            <span class="ok">vue-shaker</span> proves which prop values,
            <code>v-if</code> arms and CSS rules your app can reach — and drops
            the rest
          </li>
        </ul>
        <div class="cta">
          <a class="btn-primary" href="#playground">Try it below</a>
          <a class="btn-ghost" href="https://github.com/baseballyama/vue-shaker" rel="noreferrer">GitHub</a>
        </div>
      </div>
    </header>

    <section id="playground" class="play">
      <div class="play-head">
        <h2>Try it</h2>
        <span class="play-sub">
          The engine runs entirely in your browser. Edit the source — the
          shaken output updates live.
        </span>
      </div>
      <Playground />
    </section>

    <section class="how">
      <h2>How it works</h2>
      <div class="steps">
        <div class="step">
          <span class="num">01</span>
          <h3>Crawl every call site</h3>
          <p>
            From your entry it walks the component graph and records the value
            passed to every prop at every <code>&lt;Child/&gt;</code> — a
            literal, a default, or "unknown".
          </p>
        </div>
        <div class="step">
          <span class="num">02</span>
          <h3>Decide what's reachable</h3>
          <p>
            Never-passed and app-wide-constant props fold to their value;
            variant props with a small value set are narrowed, keeping only the
            arms they can reach. It iterates to a whole-program fixpoint, so
            folds cascade across files.
          </p>
        </div>
        <div class="step">
          <span class="num">03</span>
          <h3>Slim the source</h3>
          <p>
            Folded props leave <code>defineProps</code>, dead
            <code>v-if</code> arms and unreachable <code>&lt;style scoped&gt;</code>
            rules are deleted, and stripped attributes vanish at call sites. Vue
            compiles only what your app can reach.
          </p>
        </div>
      </div>
      <p class="caveat">
        Sound by construction: when a transform can't be proven safe (spreads,
        dynamic <code>:is</code>, shadowed names…), the code is left untouched.
        Build-time only; ships as a Vite plugin.
      </p>

      <div class="install">
        <div class="install-head">Install</div>
        <pre><span class="muted"># add the dev dependency</span>
pnpm add -D vue-shaker

<span class="muted">// vite.config.ts — place it BEFORE @vitejs/plugin-vue</span>
import { shaker } from <span class="str">'vue-shaker/vite'</span>;
import vue from <span class="str">'@vitejs/plugin-vue'</span>;

export default { plugins: [shaker(), vue()] };</pre>
      </div>
    </section>

    <footer class="foot">
      <span>vue-shaker · MIT</span>
      <span class="sep">·</span>
      <span>build-time only · the playground shakes client-side</span>
    </footer>
  </main>
</template>

<style scoped>
main {
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 clamp(16px, 4vw, 48px) 80px;
}

.hero {
  display: flex;
  align-items: center;
  gap: clamp(20px, 4vw, 56px);
  padding: clamp(44px, 9vw, 96px) 0 40px;
}
.logo {
  flex-shrink: 0;
  width: clamp(88px, 13vw, 132px);
  height: auto;
  filter: drop-shadow(0 10px 28px rgba(66, 184, 131, 0.25));
  transform-origin: 52% 80%;
  animation: shake 2.8s ease-in-out infinite;
  will-change: transform;
}
.logo:hover {
  animation-duration: 0.9s;
}
@keyframes shake {
  0%,
  100% {
    transform: translateY(0) rotate(0deg);
  }
  18% {
    transform: translateY(-5px) rotate(-2.4deg);
  }
  38% {
    transform: translateY(0) rotate(1.9deg);
  }
  58% {
    transform: translateY(-3px) rotate(-1.4deg);
  }
  78% {
    transform: translateY(0) rotate(1deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .logo {
    animation: none;
  }
}
.hero-text {
  min-width: 0;
}
.eyebrow {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 12px;
}
h1 {
  font-size: clamp(40px, 7vw, 68px);
  letter-spacing: -0.04em;
  line-height: 1;
  background: linear-gradient(120deg, var(--ink) 30%, var(--accent-2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.tagline {
  margin: 12px 0 0;
  font-size: clamp(16px, 2.4vw, 21px);
  font-weight: 600;
  color: var(--ink);
}
.lede {
  margin: 18px 0 0;
  max-width: 64ch;
  font-size: 14.5px;
  line-height: 1.75;
  color: var(--ink-dim);
}
.lede strong {
  color: var(--ink);
}
.diffs {
  list-style: none;
  margin: 18px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-width: 66ch;
}
.diffs li {
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-dim);
}
.diffs .x,
.diffs .ok {
  font-weight: 600;
  font-family: var(--mono);
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 5px;
  margin-right: 6px;
  white-space: nowrap;
}
.diffs .x {
  color: var(--del);
  background: var(--del-bg);
}
.diffs .x::before {
  content: '✕ ';
}
.diffs .ok {
  color: var(--accent);
  background: var(--accent-bg);
}
.diffs .ok::before {
  content: '✓ ';
}
code {
  color: var(--accent-2);
  background: var(--accent-bg);
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 0.9em;
}
.cta {
  display: flex;
  gap: 12px;
  margin-top: 26px;
}
.btn-primary,
.btn-ghost {
  padding: 10px 20px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
  text-decoration: none;
  transition: transform 0.1s ease;
}
.btn-primary {
  background: var(--accent);
  color: #07140d;
}
.btn-primary:hover {
  transform: translateY(-1px);
}
.btn-ghost {
  border: 1px solid var(--line-2);
  color: var(--ink);
}
.btn-ghost:hover {
  border-color: var(--accent);
}

.play {
  padding-top: 18px;
  scroll-margin-top: 24px;
}
.play-head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.play-head h2,
.how h2 {
  font-size: clamp(24px, 3.4vw, 34px);
  letter-spacing: -0.025em;
}
.play-sub {
  color: var(--ink-faint);
  font-size: 13px;
}

.how {
  padding-top: 72px;
}
.steps {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin: 26px 0 22px;
}
.step {
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--panel);
  padding: 22px;
}
.step .num {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 13px;
  color: var(--accent);
  opacity: 0.8;
}
.step h3 {
  font-size: 16px;
  margin: 10px 0 8px;
}
.step p {
  margin: 0;
  color: var(--ink-dim);
  font-size: 13px;
  line-height: 1.7;
}
.caveat {
  color: var(--ink-faint);
  font-size: 13px;
  max-width: 82ch;
  line-height: 1.7;
}

.install {
  margin-top: 24px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--bg-2);
  overflow: hidden;
}
.install-head {
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-faint);
  background: var(--bg-1);
}
.install pre {
  margin: 0;
  padding: 16px 18px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink);
  overflow-x: auto;
}
.install .muted {
  color: var(--ink-faint);
}
.install .str {
  color: var(--accent-2);
}

.foot {
  margin-top: 60px;
  padding-top: 24px;
  border-top: 1px solid var(--line);
  color: var(--ink-faint);
  font-size: 12.5px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.foot .sep {
  opacity: 0.5;
}

@media (max-width: 760px) {
  .hero {
    flex-direction: column;
    text-align: center;
  }
  .lede {
    text-align: left;
  }
  .cta {
    justify-content: center;
  }
  .steps {
    grid-template-columns: 1fr;
  }
}
</style>
