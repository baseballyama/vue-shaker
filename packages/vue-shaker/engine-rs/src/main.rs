//! CLI: `vue-shaker-rs <file.vue>` — print the Stage A SFC model as JSON.
//! Used by the differential-parity harness and for manual inspection.

use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: vue-shaker-rs <file.vue>");
        return ExitCode::FAILURE;
    };
    let source = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("{}", vue_shaker_engine::build_model_json(&source, &path));
    ExitCode::SUCCESS
}
