//! Bounded, offline evidence reader for the human report.
//!
//! The inventory follows real pack files, never symlinks. Text is escaped before
//! embedding; opening evidence does not fetch URLs or execute artifact content.

use super::*;
use std::collections::BTreeSet;
use std::io::Read;

const FILE_LIMIT: usize = 2 * 1024 * 1024;
const PACK_LIMIT: usize = 12 * 1024 * 1024;

pub(super) struct EvidenceFile {
    pub path: String,
    pub text: Option<String>,
}

pub(super) fn inventory(dir: &Path) -> Vec<EvidenceFile> {
    let mut paths: Vec<_> = walkdir::WalkDir::new(dir)
        .follow_links(false)
        .max_depth(8)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.path().strip_prefix(dir).ok().map(Path::to_path_buf))
        .filter(|p| !matches!(p.extension().and_then(|s| s.to_str()), Some("html" | "zip")))
        // A `prview mcp` run leaves its liveness and launcher logs in the
        // output directory while this walk happens. They are mutable launcher
        // controls, not pack payload — `RUNNING.json` is deleted when the run
        // ends and `run.log` can still grow after this snapshot — which is why
        // the manifest and the archive exclude them. The inventory must use the
        // same rule, or the reader presents them as immutable evidence.
        .filter(|p| !crate::artifacts::is_mcp_control_file(p))
        .collect();
    // Preserve the required handoff and failure evidence before duplicate patches
    // can consume the embedding budget.
    paths.sort_by_key(|p| {
        let name = pack_path(p);
        let priority = match name.as_str() {
            "PR_REVIEW.md" | "REVIEW_SUMMARY.md" | "AI_INDEX.md" | "report.json" => 0,
            _ if name.starts_with("00_summary/") => 0,
            _ if name.ends_with("INLINE_FINDINGS.sarif") => 0,
            _ if name.starts_with("20_quality/") => 1,
            _ if name.starts_with("30_context/") => 2,
            _ => 3,
        };
        (priority, p.clone())
    });
    let mut remaining = PACK_LIMIT;
    paths
        .into_iter()
        .map(|path| {
            let text = read_bounded(dir, &path, remaining.min(FILE_LIMIT));
            if let Some(ref text) = text {
                remaining = remaining.saturating_sub(text.len());
            }
            EvidenceFile {
                path: pack_path(&path),
                text,
            }
        })
        .collect()
}

fn pack_path(path: &Path) -> String {
    path.iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn read_bounded(dir: &Path, path: &Path, limit: usize) -> Option<String> {
    let file = crate::paths::open_file_within(dir, path).ok()?;
    if file.metadata().ok()?.len() > limit as u64 {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > limit {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    if text.contains('\0') {
        return None;
    }
    Some(text)
}

/// JSON string encoding preserves CR/LF, a leading newline and BOM through HTML
/// parsing. The reader decodes this original before previewing or downloading it.
fn encoded_original_text(text: &str) -> String {
    escape_html(&serde_json::to_string(text).expect("serializing a string cannot fail"))
}

pub(super) fn templates(files: &[EvidenceFile]) -> String {
    let mut html = String::new();
    for file in files {
        if let Some(text) = &file.text {
            let _ = write!(
                html,
                "<template data-evidence-content=\"{}\" data-content-encoding=\"json-string\"><pre>{}</pre></template>",
                escape_html(&file.path),
                encoded_original_text(text)
            );
            if file.path.ends_with(".md")
                && text.len() <= 256 * 1024
                && text.lines().count() <= 5000
            {
                let rendered = offline_markdown(text);
                let _ = write!(
                    html,
                    "<template data-evidence-rendered=\"{}\">{}</template>",
                    escape_html(&file.path),
                    rendered
                );
            }
        }
    }
    html
}

pub(super) fn offline_markdown(text: &str) -> String {
    let rendered = crate::mdrender::render(text, &super::sections::narrative_theme());
    // The dashboard owns typography and colors, including fenced code. Strip
    // inline highlighter styles so another palette cannot override its theme.
    // Automatic image loads remain disabled for offline evidence.
    ammonia::Builder::default()
        .rm_tags(["img"])
        .add_generic_attributes(["class"])
        .clean(&rendered)
        .to_string()
}

pub(super) fn relative_href(path: &str) -> String {
    let mut href = String::from("./");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            href.push(char::from(byte));
        } else {
            let _ = write!(href, "%{byte:02X}");
        }
    }
    href
}

/// Use the same repository-relative key for source links and committed blobs.
/// External locations remain displayable, but never become source-reader keys.
pub(super) fn source_path(path: &str, repo_root: &Path) -> Option<String> {
    let normalized = crate::paths::normalize_to_repo_relative(path, repo_root);
    if normalized.is_external
        || crate::paths::validate_repo_relative_str(&normalized.display).is_err()
    {
        return None;
    }
    Some(normalized.display)
}

/// Source is pinned to the diff's committed target, never the ambient checkout.
/// This is a committed reference, not the contents of any dirty-checkout overlay.
pub(super) fn source_templates(
    config: &Config,
    diffs: &[Diff],
    heuristics: Option<&HeuristicsResult>,
    findings: &[super::super::DashboardFinding],
) -> String {
    let Some(diff) = diffs.first() else {
        return String::new();
    };
    let Ok(oid) = git2::Oid::from_str(&diff.target_commit_id) else {
        return String::new();
    };
    let Ok(repo) = git2::Repository::open(&config.repo_root) else {
        return String::new();
    };
    let Ok(commit) = repo.find_commit(oid) else {
        return String::new();
    };
    let Ok(tree) = commit.tree() else {
        return String::new();
    };
    let mut paths: BTreeSet<String> = diffs
        .iter()
        .flat_map(|d| d.files.iter().map(|f| f.path.clone()))
        .collect();
    paths.extend(findings.iter().filter_map(|finding| finding.file.clone()));
    if let Some(loct) = heuristics.and_then(|h| h.loctree.as_ref()) {
        paths.extend(loct.dead_exports.iter().map(|f| f.file.clone()));
        paths.extend(loct.twins.dead_parrots.iter().map(|f| f.file.clone()));
        for twin in &loct.twins.exact_twins {
            paths.insert(twin.file_a.clone());
            paths.insert(twin.file_b.clone());
        }
        for cycle in &loct.cycles {
            paths.extend(cycle.files.iter().cloned());
        }
    }
    let mut html = String::new();
    let mut remaining = PACK_LIMIT;
    let paths: BTreeSet<_> = paths
        .into_iter()
        .filter_map(|path| source_path(&path, &config.repo_root))
        .collect();
    for path in paths {
        let Ok(entry) = tree.get_path(Path::new(&path)) else {
            continue;
        };
        if !matches!(entry.filemode(), 0o100644 | 0o100755) {
            continue;
        }
        let Ok(blob) = repo.find_blob(entry.id()) else {
            continue;
        };
        if blob.size() > remaining.min(FILE_LIMIT) || blob.is_binary() {
            continue;
        }
        let Ok(text) = std::str::from_utf8(blob.content()) else {
            continue;
        };
        remaining -= text.len();
        let _ = write!(
            html,
            "<template data-source-content=\"{}\" data-revision=\"{}\" data-content-encoding=\"json-string\"><pre>{}</pre></template>",
            escape_html(&path),
            oid,
            encoded_original_text(text)
        );
    }
    html
}

pub(super) fn reading_path(files: &[EvidenceFile], has_files: bool, has_checks: bool) -> String {
    let html = r##"<section class="card reading-path" aria-label="Review path">
    <h2 data-i18n="evidence.readingPath">Read this review</h2>
    <p data-i18n="evidence.readingHint">Start with the changes, check the results, then inspect the evidence. Full artifacts stay available here.</p>
    <div class="reading-steps">
      <a href="#section-files" data-i18n="evidence.stepChanges">1. What changed</a>
      <a href="#section-checks" data-i18n="evidence.stepChecks">2. What was checked</a>
      <a href="00_summary/FAILURES_SUMMARY.md" data-evidence-path="00_summary/FAILURES_SUMMARY.md" data-i18n="evidence.stepFailures">3. What needs attention</a>
      <a href="00_summary/PROVENANCE.json" data-evidence-path="00_summary/PROVENANCE.json" data-i18n="evidence.stepProvenance">4. What was analyzed</a>
      <a href="REVIEW_SUMMARY.md" data-evidence-path="REVIEW_SUMMARY.md" data-i18n="evidence.stepSummary">5. Read the summary</a>
    </div>
    <div class="evidence-shortcuts">
      <a href="10_diff/full.patch" data-evidence-path="10_diff/full.patch" data-i18n="evidence.diff">Full diff</a>
      <a href="00_summary/MERGE_GATE.md" data-evidence-path="00_summary/MERGE_GATE.md" data-i18n="evidence.decision">Decision and reasons</a>
      <a href="00_summary/MERGE_GATE.json" data-evidence-path="00_summary/MERGE_GATE.json" data-i18n="evidence.decisionData">Decision data</a>
      <a href="PR_REVIEW.md" data-evidence-path="PR_REVIEW.md" data-i18n="evidence.narrative">Review narrative</a>
      <a href="30_context/INLINE_FINDINGS.sarif" data-evidence-path="30_context/INLINE_FINDINGS.sarif" data-i18n="evidence.findingData">Located observations</a>
    </div>
    </section>"##;
    let mut html = html.to_string();
    for (present, link) in [
        (
            has_files,
            r##"<a href="#section-files" data-i18n="evidence.stepChanges">1. What changed</a>"##,
        ),
        (
            has_checks,
            r##"<a href="#section-checks" data-i18n="evidence.stepChecks">2. What was checked</a>"##,
        ),
    ] {
        if !present {
            html = html.replace(link, "");
        }
    }
    if files
        .iter()
        .any(|file| file.path == "30_context/INLINE_FINDINGS.sarif")
    {
        html
    } else {
        html.replace(
            r#"<a href="30_context/INLINE_FINDINGS.sarif" data-evidence-path="30_context/INLINE_FINDINGS.sarif" data-i18n="evidence.findingData">Located observations</a>"#,
            r#"<span data-i18n="evidence.noLocated">No located observations were produced in this run.</span>"#,
        )
    }
}

pub(super) fn modal() -> &'static str {
    r#"<dialog id="evidence-dialog" class="evidence-dialog" aria-labelledby="evidence-title">
    <header><div><h2 id="evidence-title"></h2><p id="evidence-note"></p></div>
    <button type="button" id="evidence-close" data-i18n="button.close">Close</button></header>
    <div class="evidence-tools"><input type="search" id="evidence-search" data-i18n-placeholder="evidence.search" placeholder="Find in this evidence" />
    <button type="button" id="evidence-next" data-i18n="evidence.next" disabled>Next match</button>
    <span id="evidence-match-count" role="status" aria-live="polite" aria-atomic="true"></span>
    <button type="button" id="evidence-format" data-i18n="evidence.raw">Show source text</button>
    <a id="evidence-original" download data-i18n="evidence.original">Download original</a></div>
    <div id="evidence-body"></div></dialog>"#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_path_links_only_to_rendered_sections() {
        for has_files in [false, true] {
            for has_checks in [false, true] {
                let html = reading_path(&[], has_files, has_checks);
                assert_eq!(html.contains("href=\"#section-files\""), has_files);
                assert_eq!(html.contains("href=\"#section-checks\""), has_checks);
                assert!(html.contains("PROVENANCE.json"));
            }
        }
    }

    #[test]
    fn inventory_excludes_mcp_control_files() {
        // The same rule the manifest and the archive apply: an MCP run's
        // liveness and launcher logs sit in the output directory but are not
        // pack evidence, and `run.log` can still grow after this snapshot.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("PR_REVIEW.md"), "summary").unwrap();
        std::fs::write(dir.path().join("RUNNING.json"), "{}").unwrap();
        std::fs::write(dir.path().join("run.log"), "launcher stdout").unwrap();
        std::fs::write(dir.path().join("run.stderr.log"), "launcher stderr").unwrap();

        let files = inventory(dir.path());
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["PR_REVIEW.md"]);
    }

    #[test]
    fn embedding_preserves_required_evidence_before_large_diff_copies() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("10_diff")).unwrap();
        for n in 0..8 {
            std::fs::write(
                dir.path().join(format!("10_diff/{n}.patch")),
                "x".repeat(FILE_LIMIT),
            )
            .unwrap();
        }
        std::fs::write(dir.path().join("PR_REVIEW.md"), "Important summary").unwrap();
        std::fs::write(dir.path().join("binary.dat"), b"a\0b").unwrap();
        std::fs::write(dir.path().join("oversize.log"), "x".repeat(FILE_LIMIT + 1)).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("PR_REVIEW.md", dir.path().join("alias.md")).unwrap();
        let files = inventory(dir.path());
        assert_eq!(
            files
                .iter()
                .find(|f| f.path == "PR_REVIEW.md")
                .unwrap()
                .text
                .as_deref(),
            Some("Important summary")
        );
        assert!(
            files
                .iter()
                .filter_map(|f| f.text.as_ref())
                .map(String::len)
                .sum::<usize>()
                <= PACK_LIMIT
        );
        assert!(
            files
                .iter()
                .find(|f| f.path == "binary.dat")
                .unwrap()
                .text
                .is_none()
        );
        assert!(
            files
                .iter()
                .find(|f| f.path == "oversize.log")
                .unwrap()
                .text
                .is_none()
        );
        assert!(!files.iter().any(|f| f.path == "alias.md"));
    }

    #[test]
    fn original_encoding_preserves_text_bytes_across_the_html_boundary() {
        let text =
            "\u{feff}\nZażółć <&>\r\n\"quoted\"\r</pre></template><script>unsafe()</script>\n";
        let html = templates(&[EvidenceFile {
            path: "20_quality/original.log".into(),
            text: Some(text.into()),
        }]);
        assert!(html.contains("data-content-encoding=\"json-string\""));
        let encoded = html
            .split("<pre>")
            .nth(1)
            .unwrap()
            .split("</pre>")
            .next()
            .unwrap();
        assert!(!encoded.contains(['\r', '\n', '<']));
        let decoded_html = encoded
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&");
        let original: String = serde_json::from_str(&decoded_html).unwrap();
        assert_eq!(original.as_bytes(), text.as_bytes());
        assert!(
            modal().contains("id=\"evidence-match-count\" role=\"status\" aria-live=\"polite\"")
        );
    }

    #[test]
    fn raw_templates_are_inert_and_markdown_cannot_load_remote_resources() {
        let text = "# Evidence\n![remote](https://example.com/image.png)\n<script>alert(1)</script>\n</pre></template><script>unsafe()</script>\n[Next](../PR_REVIEW.md)";
        let html = templates(&[EvidenceFile {
            path: "20_quality/test.md".into(),
            text: Some(text.into()),
        }]);
        assert!(html.contains("&lt;/template&gt;"));
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img"));
        assert!(html.contains("href=\"../PR_REVIEW.md\""));
        let many_lines = templates(&[EvidenceFile {
            path: "large.md".into(),
            text: Some("x\n".repeat(6000)),
        }]);
        assert!(!many_lines.contains("data-evidence-rendered"));
    }

    #[test]
    fn finding_sources_use_target_blobs_even_when_unchanged_or_checkout_dirty() {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        std::fs::write(dir.path().join("unchanged.rs"), "committed evidence\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("unchanged.rs")).unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Test", "test@example.com").unwrap();
        let oid = repo
            .commit(Some("HEAD"), &signature, &signature, "fixture", &tree, &[])
            .unwrap();
        std::fs::write(dir.path().join("unchanged.rs"), "ambient content").unwrap();
        let mut config = crate::config::test_config();
        config.repo_root = dir.path().to_path_buf();
        let diff = Diff {
            base: "main".into(),
            target: "feature".into(),
            base_commit_id: oid.to_string(),
            target_commit_id: oid.to_string(),
            files: vec![],
            stats: Default::default(),
            commits: vec![],
        };
        let finding = super::super::super::DashboardFinding {
            level: "error",
            check_name: "test".into(),
            check_id: "test".into(),
            message: "failed".into(),
            file: Some(dir.path().join("unchanged.rs").display().to_string()),
            line: Some(1),
            in_diff: None,
        };
        let mut ctx = super::super::tests::mock_ctx();
        ctx.findings = vec![finding.clone()];
        let links = super::super::sections::build_sarif_table_section(&ctx, &config.repo_root);
        assert!(links.contains("data-source-path=\"unchanged.rs\""));
        let html = source_templates(&config, &[diff], None, &[finding]);
        assert!(html.contains("data-source-content=\"unchanged.rs\""));
        assert!(source_path("../outside.rs", &config.repo_root).is_none());
        assert!(html.contains("committed evidence"));
        assert!(html.contains("data-content-encoding=\"json-string\""));
        assert!(!html.contains("ambient content"));
        assert!(html.contains(&oid.to_string()));
    }
}
