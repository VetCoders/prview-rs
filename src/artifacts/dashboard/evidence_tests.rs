use super::*;
use crate::checks::{CheckResult, CheckStatus};
use crate::heuristics::{HeuristicsRegression, HeuristicsResult, LoctreeAnalysis};
use std::time::Duration;

#[test]
fn loctree_details_preserve_locations_escape_html_and_show_baseline_scope() {
    let analysis: LoctreeAnalysis = serde_json::from_value(serde_json::json!({
        "available": true,
        "stats": {"total_files": 3, "total_loc": 40, "by_language": {"": {"files": 1, "loc": 2}}},
        "dead_exports": [{"file": "src/a.py", "symbol": "<unsafe>", "line": 42, "confidence": "low"}],
        "cycles": [{"files": ["src/a.py", "src/b.py"], "length": 2}],
        "twins": {
            "dead_parrots": [{"file": "src/b.py", "symbol": "unused", "kind": "function", "line": 5}],
            "exact_twins": [{"file_a": "src/a.py", "file_b": "src/b.py", "symbol": "shared_name"}],
            "total_symbols": 4
        }
    })).unwrap();
    let heuristics = HeuristicsResult {
        loctree: Some(analysis),
        regression: Some(HeuristicsRegression {
            dead_exports_delta: 0,
            ..Default::default()
        }),
        ..Default::default()
    };
    let html = build_loctree_section(Some(&heuristics));
    assert!(html.contains("whole analyzed repository"));
    assert!(html.contains("Count change vs base"));
    assert!(html.contains("data-source-path=\"src/a.py\" data-source-line=\"42\""));
    assert!(html.contains("&lt;unsafe&gt;"));
    assert!(!html.contains("<unsafe>"));
    assert!(html.contains("low"));
    assert!(html.contains("Unknown language"));
    assert!(html.contains("shared_name"));
    assert!(html.contains("do not establish duplicate implementations"));
    assert!(html.contains("runtime use may exist"));
    assert_eq!(html.matches("<details class=\"issue-card\">").count(), 4);
}

#[test]
fn zero_duration_and_skipped_checks_are_never_presented_as_fast_successes() {
    let checks = vec![
        CheckResult {
            name: "Mypy".into(),
            status: CheckStatus::Error,
            duration: Duration::ZERO,
            output: "tool missing".into(),
            cached: false,
            provenance: None,
        },
        CheckResult {
            name: "Pytest".into(),
            status: CheckStatus::Skipped,
            duration: Duration::ZERO,
            output: "not requested".into(),
            cached: false,
            provenance: None,
        },
    ];
    let html = build_time_budget(&checks);
    assert!(html.contains("Not measured"));
    assert!(html.contains("status.error"));
    assert!(html.contains("status.skipped"));
    assert!(html.contains("not total report preparation time"));
    assert!(!html.contains("label.slowest"));
}

#[test]
fn findings_use_recorded_location_and_general_notes_remain_neutral() {
    let mut ctx = super::tests::mock_ctx();
    ctx.findings = vec![
        super::super::DashboardFinding {
            level: "error",
            check_name: "Pytest".into(),
            check_id: "pytest".into(),
            message: "Assertion failed; src/wrong.py:999 is merely quoted output".into(),
            file: Some("tests/test_parser.py".into()),
            line: Some(17),
            in_diff: Some(true),
        },
        super::super::DashboardFinding {
            level: "note",
            check_name: "Loctree".into(),
            check_id: "heuristics_loctree".into(),
            message: "Repository structural summary".into(),
            file: None,
            line: None,
            in_diff: None,
        },
    ];
    let html = build_sarif_table_section(&ctx, Path::new("/repo"));
    assert!(html.contains("data-source-path=\"tests/test_parser.py\" data-source-line=\"17\""));
    assert!(!html.contains("data-source-path=\"src/wrong.py\""));
    assert!(html.contains("General signal; no code location"));
    assert!(html.contains("label.information"));
    assert!(!html.contains("label.warning"));
}

#[test]
fn test_matching_is_a_file_ratio_not_executed_code_coverage() {
    let mut ctx = super::tests::mock_ctx();
    ctx.coverage.covered_count = 1;
    ctx.coverage.total_source = 1;
    let html = build_coverage_section(&ctx);
    assert!(html.contains(">1/1</span>"));
    assert!(!html.contains(">100%</span>"));
    assert!(html.contains("not actual code coverage"));
}

#[test]
fn inline_test_marker_is_rendered_as_text_not_as_a_source_link() {
    use crate::artifacts::signal::{CoverageMatchTier, CoveragePair, INLINE_TEST_MARKER};

    let mut ctx = super::tests::mock_ctx();
    ctx.coverage.covered_count = 2;
    ctx.coverage.total_source = 2;
    ctx.coverage.covered = vec![
        CoveragePair {
            src_status: 'M',
            src_path: "src/self_tested.rs".into(),
            test_status: 'M',
            test_path: INLINE_TEST_MARKER.into(),
            tier: CoverageMatchTier::High,
        },
        CoveragePair {
            src_status: 'M',
            src_path: "src/paired.rs".into(),
            test_status: 'M',
            test_path: "tests/paired.rs".into(),
            tier: CoverageMatchTier::High,
        },
    ];

    let html = build_coverage_section(&ctx);

    // A real test file stays navigable; the synthetic marker never reaches the
    // reader as a path, because no blob can be embedded under it.
    assert!(html.contains("data-source-path=\"tests/paired.rs\""));
    assert!(html.contains(&escape_html(INLINE_TEST_MARKER)));
    assert!(
        !html.contains(&format!(
            "data-source-path=\"{}\"",
            escape_html(INLINE_TEST_MARKER)
        )),
        "the inline-test marker must not be handed to the source reader"
    );
}

#[test]
fn pytest_check_preview_shows_failure_and_keeps_complete_log_on_demand() {
    let ctx = super::tests::mock_ctx();
    let checks = vec![CheckResult {
        name: "Pytest".into(), status: CheckStatus::Failed, duration: Duration::from_secs(90), cached: false, provenance: None,
        output: "=== test session starts ===\nprogress 1\nprogress 2\nFAILED tests/test_parser.py::test_unknown - AssertionError: unsupported record\n".into(),
    }];
    let html = build_checks_section(&checks, &ctx);
    let preview = html
        .split("<details><summary data-i18n=\"button.fullCheckOutput\"")
        .next()
        .unwrap();
    assert!(preview.contains("unsupported record"));
    assert!(!preview.contains("test session starts"));
    assert!(html.contains("test session starts"));
    assert!(!html.contains("cargo test"));
}
