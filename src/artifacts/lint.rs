//! Lint view over the canonical findings model (PRV-205).
//!
//! This module owns no truth of its own. It regroups the rows the canonical
//! findings model already emitted so the dashboard can show them per lint
//! check; it never re-parses check output and never decides whether a finding
//! was introduced by the reviewed change.

use super::*;

// ---------------------------------------------------------------------------
// PRV-205: Lint findings projection
// ---------------------------------------------------------------------------

/// Did this lint check actually run?
///
/// `Skipped` and `Error` both mean no lint result was produced: an errored
/// check failed to launch or crashed, so whatever it wrote is a runner
/// diagnostic, not a verdict about the code. The renderer and this projection
/// share the predicate so a card cannot say "not executed" while the section
/// header counts a row from the same check.
pub(crate) fn lint_check_executed(status: CheckStatus) -> bool {
    matches!(
        status,
        CheckStatus::Passed | CheckStatus::Failed | CheckStatus::Warnings
    )
}

/// Check if a check result is lint-related based on its name.
pub(crate) fn is_lint_check(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("clippy")
        || lower.contains("eslint")
        || lower.contains("ruff")
        || lower.contains("mypy")
        || lower.contains("lint")
        || lower.contains("pylint")
        || lower.contains("biome")
        || lower.contains("stylelint")
}

/// Project canonical findings onto the lint checks that produced them.
///
/// The only operation performed here is grouping and counting canonical rows by
/// their canonical `in_diff` tri-state:
///
/// - `Some(true)`  — the tool located the finding in a file this diff touches.
///   That is a location signal, not evidence the change introduced it.
/// - `Some(false)` — the tool located it outside the changed files.
/// - `None`        — the canonical model could not establish the origin.
///
/// A lint check that did not execute (`Skipped`/`Error`) contributes no
/// findings; its canonical status travels with the entry so the renderer can
/// say "not executed" instead of "no findings".
pub(crate) fn project_lint_metrics(
    checks: &[CheckResult],
    findings: &[DashboardFinding],
) -> Vec<LintMetrics> {
    use std::collections::BTreeSet;

    let mut metrics = Vec::new();

    for check in checks {
        if !is_lint_check(&check.name) {
            continue;
        }

        let check_id = crate::check_id::check_id_from_name(&check.name);
        let mut findings_in_changed_files = 0usize;
        let mut findings_outside_changed_files = 0usize;
        let mut findings_origin_unknown = 0usize;
        let mut total_findings = 0usize;
        let mut changed_files: BTreeSet<String> = BTreeSet::new();

        // A check that did not execute contributes nothing to count. The
        // canonical model still emits a generic row for an errored check —
        // its runner or setup diagnostic — and counting that row produced an
        // "origin unknown / 1 total" header above a card stating that no
        // result was produced.
        let countable: &[DashboardFinding] = if lint_check_executed(check.status) {
            findings
        } else {
            &[]
        };

        for finding in countable.iter().filter(|f| f.check_id == check_id) {
            total_findings += 1;
            match finding.in_diff {
                Some(true) => {
                    findings_in_changed_files += 1;
                    if let Some(file) = &finding.file {
                        changed_files.insert(file.clone());
                    }
                }
                Some(false) => findings_outside_changed_files += 1,
                None => findings_origin_unknown += 1,
            }
        }

        metrics.push(LintMetrics {
            check_name: check.name.clone(),
            status: check.status,
            findings_in_changed_files,
            findings_outside_changed_files,
            findings_origin_unknown,
            total_findings,
            changed_files_with_findings: changed_files.into_iter().collect(),
        });
    }

    metrics
}
