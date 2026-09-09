# Dashboard locales

`en.json` and `pl.json` are embedded into the self-contained HTML dashboard with
`include_str!`. Edit `pl.json` directly when adjusting Polish UI copy; no Rust
string editing is needed for dictionary entries.

Rules for editing:

- Keep the same key set in `en.json` and `pl.json`.
- Values must stay JSON strings.
- Keep placeholders such as `{count}`, `{covered}`, `{passed}`, and `{total}`
  identical in both locales and aligned with the rendering call site.
- Keep product/tool names and common dev terms natural: `prview`, `PR`, `merge`,
  `review`, `runtime`, `dashboard`, `i18n`, `Loctree`, `Vibecrafted`.
- Follow the vetcoders-agents localization canon:
  `vibecrafted_glossary_rules-PL.md` and
  `vibecrafted-skill-PL-localization-spec.md`. A prview-specific glossary is
  planned there as `prview_glossary_rules-PL.md`; until it exists, use the
  general glossary plus the existing dashboard tone.

The dashboard's human-facing vocabulary describes what was actually measured:

| Meaning | English | Polish |
|---------|---------|--------|
| Source-to-test matching | Tests for changed files | Testy dla zmienionych plików |
| Structural indicators, not behavioral assurance | Code change structure | Struktura zmian w kodzie |
| Recorded check durations | Check duration | Czas kontroli |
| Attributed tool output, not a PRView diagnosis | Tool observations | Uwagi z narzędzi |
| CODEOWNERS declarations | Ownership | Odpowiedzialność za pliki |

Do not translate heuristic matching into a claim of executed-code coverage, or
a repeated export name into proof of duplicate implementations. Source tool
names and raw evidence stay intact. Known status explanations and navigation
should use the selected language; the raw log remains available for checking
the original message. Skipped-check details retain their original reason in
`data-reason` and translate known reasons through the shared reason translator.

For Polish numeric labels, prefer `Liczba plików: {count}` or `Uwagi: {count}`
to a fixed suffix that breaks at one, two or five. Keep `evidence.*` keys aligned
with the reading path, search, source preview and download controls.

Run the parity/embed tests locally:

```bash
cargo test dashboard_locale_key_parity_en_pl
cargo test dashboard_js_embeds_escaped_locale_json
```
