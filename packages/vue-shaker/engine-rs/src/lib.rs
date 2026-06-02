//! vue-shaker Rust engine — Stage A (parser + model extraction).
//!
//! See `docs/RUST-MIGRATION.md`.  This is the staged port of the TypeScript
//! engine onto the [vize](https://github.com/baseballyama/vize) Vue toolchain,
//! verified by differential parity against the TS engine.
//!
//! Stage A parses a `.vue` SFC with `vize_atelier_sfc::parse_sfc` (the canonical
//! Vue SFC splitter) and its template with `vize_armature::parse` (the Vue
//! template parser), then emits a JSON `SfcModel` — the Rust-side counterpart of
//! the TS engine's per-file extraction.  The TS test `tests/wasm-parity.test.ts`
//! compares this against `parseVue` for the shared fixtures.
//!
//! Stage B (whole-program value-set lattice + fixpoint -> `ComponentPlan`) and
//! Stage C (transform + emit) are tracked in `docs/RUST-MIGRATION.md`.

use serde::Serialize;
use vize_armature::{Allocator, parse as parse_template};
use vize_atelier_sfc::{parse_sfc, types::SfcParseOptions};

/// One `<style>` block, as the model reports it.
#[derive(Debug, Serialize)]
pub struct StyleModel {
    pub scoped: bool,
    pub content: String,
}

/// The Rust-side per-file model — mirrors the fields the TS engine extracts in
/// `parse.ts` / the start of `analyze.ts` (block structure + template stats).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SfcModel {
    pub filename: String,
    pub has_script_setup: bool,
    pub script_setup_content: Option<String>,
    pub template_content: Option<String>,
    /// Number of top-level template children parsed by `vize_armature`.
    pub template_child_count: usize,
    /// Number of template parse errors `vize_armature` reported (0 == clean).
    pub template_parse_errors: usize,
    pub styles: Vec<StyleModel>,
    /// Set when the SFC could not be parsed at all.
    pub error: Option<String>,
}

impl SfcModel {
    fn errored(filename: &str, message: String) -> Self {
        SfcModel {
            filename: filename.to_string(),
            has_script_setup: false,
            script_setup_content: None,
            template_content: None,
            template_child_count: 0,
            template_parse_errors: 0,
            styles: Vec::new(),
            error: Some(message),
        }
    }
}

/// Parse one `.vue` source into an [`SfcModel`] using the vize toolchain.
pub fn build_model(source: &str, filename: &str) -> SfcModel {
    let options = SfcParseOptions {
        filename: filename.into(),
        ..Default::default()
    };
    let descriptor = match parse_sfc(source, options) {
        Ok(d) => d,
        Err(e) => return SfcModel::errored(filename, format!("{e:?}")),
    };

    // Parse the template with the Vue template parser to validate it and count
    // top-level children — the hot path the Rust port exists to accelerate.
    let (template_content, child_count, parse_errors) = match &descriptor.template {
        Some(block) => {
            let content = block.content.to_string();
            let allocator = Allocator::default();
            // Scope the borrow: `root`/`errors` borrow `content`, so read the
            // counts (Copy) and drop them before moving `content` out.
            let (child_count, parse_errors) = {
                let (root, errors) = parse_template(&allocator, &content);
                (root.children.len(), errors.len())
            };
            (Some(content), child_count, parse_errors)
        }
        None => (None, 0, 0),
    };

    SfcModel {
        filename: filename.to_string(),
        has_script_setup: descriptor.script_setup.is_some(),
        script_setup_content: descriptor.script_setup.as_ref().map(|s| s.content.to_string()),
        template_content,
        template_child_count: child_count,
        template_parse_errors: parse_errors,
        styles: descriptor
            .styles
            .iter()
            .map(|s| StyleModel { scoped: s.scoped, content: s.content.to_string() })
            .collect(),
        error: None,
    }
}

/// Parse one `.vue` source and return the model as a JSON string.
pub fn build_model_json(source: &str, filename: &str) -> String {
    serde_json::to_string(&build_model(source, filename))
        .unwrap_or_else(|e| format!("{{\"error\":\"serialize: {e}\"}}"))
}

#[cfg(feature = "wasm")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// WASM entry: `parseModelJson(source, filename) -> JSON string`.
    #[wasm_bindgen(js_name = parseModelJson)]
    pub fn parse_model_json(source: &str, filename: &str) -> String {
        super::build_model_json(source, filename)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUTTON: &str = r#"<script setup lang="ts">
const { variant = 'primary', loading = false } = defineProps<{ variant?: string; loading?: boolean }>()
</script>

<template>
  <button :class="['btn', `btn-${variant}`]">
    <span v-if="loading">...</span>
    <slot />
  </button>
</template>

<style scoped>
.btn { color: black }
.btn-danger { color: red }
</style>
"#;

    #[test]
    fn extracts_sfc_blocks_via_vize() {
        let m = build_model(BUTTON, "Button.vue");
        assert!(m.error.is_none(), "unexpected error: {:?}", m.error);
        assert!(m.has_script_setup);
        assert!(m.script_setup_content.as_ref().unwrap().contains("defineProps"));
        assert!(m.template_content.is_some());
        assert_eq!(m.template_parse_errors, 0, "template should parse cleanly");
        assert!(m.template_child_count >= 1);
        assert_eq!(m.styles.len(), 1);
        assert!(m.styles[0].scoped);
        assert!(m.styles[0].content.contains(".btn-danger"));
    }

    #[test]
    fn reports_no_script_setup() {
        let m = build_model("<template><div/></template>", "Plain.vue");
        assert!(!m.has_script_setup);
        assert!(m.script_setup_content.is_none());
    }
}
