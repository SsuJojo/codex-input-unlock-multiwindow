# Attribution

This project is a fork of [1zero224/codex-input-unlock](https://github.com/1zero224/codex-input-unlock),
licensed under the MIT License (see [LICENSE](LICENSE)).

- Upstream project & controller scripts: **1zero224** — `codex-input-unlock.ps1` (PowerShell controller,
  install / launch / verify actions), `quota-gate.cjs` (optional conditional-breakpoint fallback),
  and the original single-target supervisor and network patch, from which `cdp-supervisor.mjs`
  and `quota-net-patch.cjs` derive.
- Multi-window fork: this repository's `cdp-supervisor.mjs` (poll / attach every `app://` page target,
  per-target worker supervision, incremental re-injection after reload, atomic status writing) and
  `quota-net-patch.cjs` (nulls `rate_limit_upsell` / `model_picker_upsell` so the "quota exhausted"
  banner is cleared as well).

The upstream license notice is preserved in [LICENSE](LICENSE). This fork is distributed under the
same MIT License.
