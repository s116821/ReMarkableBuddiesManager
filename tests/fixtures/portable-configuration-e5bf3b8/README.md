# Actual portable import producer corpus

Source contents: e5bf3b8ad7f5681f3f90d7cfc097aee3cae53ca3.
Central contract: Docs2087f0cec22ceb405275bda30dcb4271a9a26789.

This reuses the prior real-producer corpus pattern: a small Rust API setup helper
creates synthetic owned Stores, then a bounded subprocess capture records the
actual built CLI's stdin/stdout/stderr without rewriting reports. It adds no
production framework or repository edits. All paths are original Windows host
paths. No tablet identity or native/runtime/provider claim is made.

The existing CLI was compiled from source contents subsequently committed as
e5bf3b8; its actual version is `remarkable-reader-buddy dev.v0.73.0-dirty`.
That precommit build metadata is intentionally retained, not relabeled as a clean
commit/release binary. The corpus pins CLI, setup helper/source and reused rlib.

From the importer source worktree, the setup helper was built with:

```text
rustc --edition=2021 ../portable-import-corpus-e5bf/setup.rs --extern remarkable_reader_buddy=../ordinary-configuration-target/debug/deps/libremarkable_reader_buddy-6b8a86c58140f756.rlib -L dependency=../ordinary-configuration-target/debug/deps -o ../portable-import-corpus-e5bf/setup.exe
```

Capture command (PYTHONUTF8=1 in the process environment):

```text
C:/msys64/ucrt64/bin/python.exe -B ../portable-import-corpus-e5bf/capture.py
```

The successful run is `run-7cef1c7c-b9f0-4262-bdd7-140aa085d329/packet`.
`corpus.json` records26 actual producer cases, exact argv/cwd/selected Config/
environment, original stdout UTF8 and stdin base64 plus byte hashes. Separate
`.bin` files preserve the original bytes independently of JSON representations.
Three `.artifact.compact.json` files are exact byte slices from actual Rust export
stdout, verified against Rust's emitted artifact digest, never reserialized.
Original synthetic source Configs and before/after destination files are included.

The cases cover rich and sparse/null exports, Inspect/Prepare/Apply/Status for
actual legacy1 and notebook4 Stores, Busy before successful Apply, no-change,
empty overlay, stale base, foreign artifact, duplicate member, unsupported version,
alternate path, missing/invalid whole Config and NUL text refusal. Supported text
includes Unicode, CR/LF/tab/backspace/formfeed/U+0001, quote, backslash and literal
U+2028/U+2029. NUL is refused by the existing validator. The preliminary failed
capture used NUL in its intended success input; its original script/log/raw export
refusal remain in the separate earlier run, not rewritten into a success.

`check-json-digests.cjs` checks Node's recursively sorted JSON bytes against all
three actual Rust compact artifacts, including reversed input key order, and
verifies every raw stdin/stdout/stderr and lossless JSON representation. It does
not change producer outputs. Run it with Node and the packet directory as its
only argument; its original output is retained as separate comparison evidence.

`file-manifest.json` pins packet files (excluding itself). Transfer only this
small packet and its externally pinned manifest, not build caches, setup binaries
or synthetic Store trees. Setup binaries are disposable after capture; sources,
commands, hashes and all useful successful/failed evidence remain retained.
