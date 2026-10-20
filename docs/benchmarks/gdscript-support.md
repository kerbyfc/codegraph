# GDScript follow-up validation

Date: 2026-10-20. Contribution base: `kerbyfc/codegraph` branch
`gdscript-signals-scenes`, commit `1334700077972b71736b95b5e9e97a09cf47fee7`
(upstream PR #2623). The existing language, grammar, scene/resource extractor,
and original contributor commits are retained.

## Scope

A script is one class, including when it has no `class_name`. Its methods,
fields, properties, enums, and inner classes have that owner. Calls use that
ownership, declared receiver types, typed array loop items, literal script
imports, inheritance, and enabled autoload names. Named RPC calls retain the
method they invoke. Autoload configuration edits rebind unchanged callers,
including during scoped watcher syncs.

Signal dispatch joins emissions and named subscriptions by the resolved signal
**declaration ID**, with heuristic provenance and the registration location.
Same-named signals in different classes remain separate. Untyped receivers,
engine-native signals, anonymous handlers, and chains without type evidence
stay unresolved. The existing scene/resource extraction remains in place;
scene-path references retain their identity when a scene is removed/restored.

## Checks on the follow-up branch

- Build and asset-copy checks pass, including the unchanged grammar bytes and
  the added upstream MIT license alongside the distributed grammar.
- 40 focused checks pass across the GDScript, inherited signals/scenes,
  synthesized-hop rendering, grammar-buffer, and grammar-preload suites.
- 780 extraction, sync, and cross-language regression checks pass.
- The full suite has not been rerun on this older PR base; these subset results
  are not a claim that the complete suite is green.

The grammar's SHA-256 remains
`5c65071d058206320fd9d38d55748e268b71cb7b3586cde0fd68f94ffea5728a`.
Its ABI-14 multi-grammar reuse probe passed 20/20 parses. Source/toolchain
provenance remains in `docs/grammars/tree-sitter-gdscript.md`.

## Real projects

Sparse checkouts contain `.gd` scripts and `project.godot`, with identical
available files for both retrieval-study arms. Scene/resource behavior is
covered by the inherited real-SQLite fixture, including delete/restore sync.

| Repository | Pinned revision | GDScript files |
|---|---|---:|
| mbrlabs/Lorien | `17e32227dfce5477292d9f0a55d6cb07d37a2bb1` | 50 |
| Orama-Interactive/Pixelorama | `3bfdc2737be94ab658b5d0da067ce3ebada50889` | 249 |
| godotengine/godot-demo-projects | `b761b4cd5718a7118f2c95eb55f181d0a5f004f1` | 461 |

All three index without extraction errors. Deterministic probes cover save/load
and zoom calls in Lorien, serialization/deserialization/undo in Pixelorama, and
lobby/game-start/connection/end-game code in the multiplayer bomber demo.
The save path connects `Main._save_project` → `ProjectManager.save_project` →
`Serializer.save_project`; the bomber path connects `_on_start_pressed` →
`begin_game` → `load_world`. Some overloaded-name queries expose the correct
callers/source without rendering a Flow section; no complete flow-rendering
coverage claim is made.

## Exploratory retrieval study

This study measured the implementation **before stacking it on PR #2623**, on
upstream-main base `8beab37c46b5006231b9201f4b44a1fc7ecd4979`. Treat it as
exploratory evidence, not a release gate for the final follow-up branch.

Harness: `scripts/agent-eval/run-all.sh`, Sonnet / high effort, two runs per arm,
three consecutive questions per run. Each arm starts a fresh session and resumes
it for questions 2/3. All with-arm MCP connections succeeded; the CLI returned
no output in either arm. Times sum the three turn durations; tool counts include
all tools, including Bash. No cost or token aggregates are inferred from the
last turn's usage.

| Repository | With: tools / Read / seconds | Without: tools / Read / seconds |
|---|---|---|
| Lorien | 3 / 0 / 31.7–52.9 | 14 / 5–6 / 54.0–95.9 |
| Pixelorama | 5–8 / 0–1 / 69.0–75.7 | 16–20 / 7–11 / 64.4–101.1 |
| Godot demos | 2 / 0 / 22.8–27.8 | 10–11 / 6–7 / 32.4–36.8 |

Grep tool calls were zero throughout; without-arm Bash calls also searched/read
source. Pixelorama used two Bash calls in one with-arm run and occasionally
needed two explores per question. Its duration ranges overlap, and the first
with-arm run was slower than the corresponding without-arm run.

The strict explore-call budget and the large indexed-repository tier remain
open. Godot demos have 4,071 tracked files but only 600 indexed records in this
source-only checkout; this is not a >1,500-indexed-file validation. The study
also does not establish an agent A/B control-repository regression verdict.
