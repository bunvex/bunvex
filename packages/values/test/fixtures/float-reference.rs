// The reference that wrote float-text.tsv (STUDY-18 §8). Not built by the repo: put it in a cargo project's
// src/main.rs with `serde_json = "=1.0.151"` (Convex's lockfile) and pipe hex bit patterns through it.
//
// Reads f64 bit patterns (hex u64, one per line) and prints, tab-separated: the bits, Rust's `{:?}`, and
// serde_json's text (empty when serde_json cannot print it).
use std::io::{self, BufRead, Write};
fn main() {
    let stdin = io::stdin();
    let mut out = io::BufWriter::new(io::stdout());
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let bits = u64::from_str_radix(line.trim(), 16).unwrap();
        let f = f64::from_bits(bits);
        let json = serde_json::Number::from_f64(f)
            .map(|n| serde_json::to_string(&serde_json::Value::Number(n)).unwrap())
            .unwrap_or_default();
        writeln!(out, "{}\t{:?}\t{}", line.trim(), f, json).unwrap();
    }
}
