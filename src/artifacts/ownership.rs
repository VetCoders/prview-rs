//! Declared code responsibility from CODEOWNERS on the reviewed substrate.

use super::*;

// ── Ownership map (CODEOWNERS + path-based fallback) ─────────────

/// A single CODEOWNERS entry mapping a pattern to one or more owners.
pub(crate) struct OwnershipEntry {
    pub pattern: String,
    pub owners: Vec<String>,
}

/// Parse a CODEOWNERS file if it exists.
///
/// Searches (in order): `.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`.
/// Returns an empty vec on any error — completely defensive.
#[cfg(test)]
pub(crate) fn load_codeowners(repo_root: &Path) -> Vec<OwnershipEntry> {
    let candidates = [
        repo_root.join(".github/CODEOWNERS"),
        repo_root.join("CODEOWNERS"),
        repo_root.join("docs/CODEOWNERS"),
    ];

    let content = candidates.iter().find_map(|p| fs::read_to_string(p).ok());

    let Some(content) = content else {
        return Vec::new();
    };

    parse_codeowners(&content)
}

/// Parse CODEOWNERS content into ownership entries.
pub(crate) fn parse_codeowners(content: &str) -> Vec<OwnershipEntry> {
    let mut entries = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(pattern) = parts.next() else {
            continue;
        };
        // Inline comments are not owners; an empty rule can clear a broader assignment.
        let owners: Vec<String> = parts
            .take_while(|part| !part.starts_with('#'))
            .map(str::to_string)
            .collect();
        entries.push(OwnershipEntry {
            pattern: pattern.to_string(),
            owners,
        });
    }
    entries
}

/// Find the owner for a given file path.
///
/// Strategy:
/// 1. Match against CODEOWNERS patterns (last match wins, per GitHub convention)
/// 2. If no CODEOWNERS match: use the second path component as module name
///    (e.g. `src/checks/foo.rs` -> `checks`, `tests/unit.rs` -> `tests`)
/// 3. If path has only one component: `root`
/// 4. Absolute fallback: `unassigned`
#[cfg(test)]
pub(crate) fn find_owner(path: &str, codeowners: &[OwnershipEntry]) -> String {
    // CODEOWNERS: last matching rule wins (GitHub convention)
    let mut best_match: Option<&[String]> = None;
    for entry in codeowners {
        if codeowners_pattern_matches(&entry.pattern, path) {
            best_match = Some(&entry.owners);
        }
    }
    if let Some(owners) = best_match {
        return owners.join(", ");
    }

    // Path-based fallback: use second component as module name
    path_based_module(path)
}

/// Derive a module name from a file path.
///
/// `src/checks/foo.rs` -> `checks`
/// `tests/unit.rs` -> `tests`
/// `Cargo.toml` -> `root`
#[cfg(test)]
pub(crate) fn path_based_module(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() >= 3 {
        // src/checks/foo.rs -> "checks"
        parts[1].to_string()
    } else if parts.len() == 2 {
        // tests/foo.rs -> "tests"
        parts[0].to_string()
    } else {
        "root".to_string()
    }
}

/// Match supported CODEOWNERS patterns without crossing a single-star separator.
///
/// A leading slash or an internal slash anchors a pattern to the repository
/// root. Bare names and directory names match at any depth. A trailing slash
/// addresses directories and their descendants; `docs/*` addresses only the
/// immediate children. Negation, bracket ranges and escaped paths are not part
/// of this supported CODEOWNERS subset and never create an owner assignment.
pub(crate) fn codeowners_pattern_matches(pattern: &str, path: &str) -> bool {
    if pattern.is_empty() || pattern.starts_with('!') || pattern.contains(['[', ']', '\\']) {
        return false;
    }
    let directory_only = pattern.ends_with('/');
    let rooted = pattern.starts_with('/');
    let body = pattern.trim_start_matches('/').trim_end_matches('/');
    if body.is_empty() {
        return false;
    }
    let glob = if rooted || body.contains('/') {
        body.to_string()
    } else {
        format!("**/{body}")
    };
    let Ok(compiled) = glob::Pattern::new(&glob) else {
        return false;
    };
    let options = glob::MatchOptions {
        case_sensitive: true,
        require_literal_separator: true,
        require_literal_leading_dot: false,
    };
    if !directory_only && compiled.matches_with(path, options) {
        return true;
    }

    // Literal directory names (including **/logs) own their descendants. Do
    // not promote a wildcard child match such as docs/* to a recursive rule.
    let final_component = body.rsplit('/').next().unwrap_or(body);
    if directory_only || !final_component.contains(['*', '?']) {
        for (separator, _) in path.match_indices('/') {
            if compiled.matches_with(&path[..separator], options) {
                return true;
            }
        }
    }
    false
}

/// Build an ownership map for a set of file paths.
#[cfg(test)]
pub(crate) fn build_ownership_map(
    repo_root: &Path,
    file_paths: &[String],
) -> Vec<(String, String)> {
    let codeowners = load_codeowners(repo_root);
    file_paths
        .iter()
        .filter_map(|path| {
            let owner = declared_owner(path, &codeowners)?;
            Some((path.clone(), owner))
        })
        .collect()
}

/// Read the ownership rules from the reviewed commit, never the ambient checkout.
pub(crate) fn build_ownership_map_at_revision(
    repo: &Repository,
    target: &str,
    file_paths: &[String],
) -> Vec<(String, String)> {
    let rules = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
        .iter()
        .find_map(|path| {
            if repo.regular_file_at_commit(target, path).ok()? {
                repo.file_at_commit(target, path).ok()
            } else {
                None
            }
        })
        .map(|content| parse_codeowners(&content))
        .unwrap_or_default();
    file_paths
        .iter()
        .filter_map(|path| declared_owner(path, &rules).map(|owner| (path.clone(), owner)))
        .collect()
}

fn declared_owner(path: &str, rules: &[OwnershipEntry]) -> Option<String> {
    rules
        .iter()
        .rev()
        .find(|entry| codeowners_pattern_matches(&entry.pattern, path))
        .filter(|entry| !entry.owners.is_empty())
        .map(|entry| entry.owners.join(", "))
}

#[cfg(test)]
mod evidence_tests {
    use super::*;

    #[test]
    fn path_modules_never_become_declared_owners() {
        let root = tempfile::tempdir().unwrap();
        let paths = vec!["src/parser.rs".into(), "tests/test_parser.py".into()];
        assert!(build_ownership_map(root.path(), &paths).is_empty());
        std::fs::write(
            root.path().join("CODEOWNERS"),
            "src/ @parser-team # keep comment out\ntests/\n",
        )
        .unwrap();
        assert_eq!(
            build_ownership_map(root.path(), &paths),
            vec![("src/parser.rs".into(), "@parser-team".into())]
        );
    }

    #[test]
    fn empty_specific_rule_clears_broader_owner() {
        let rules = parse_codeowners("* @team\nsrc/private/ # no owner\n");
        assert_eq!(
            declared_owner("src/main.rs", &rules).as_deref(),
            Some("@team")
        );
        assert_eq!(declared_owner("src/private/item.rs", &rules), None);
    }

    #[test]
    fn codeowners_root_and_nested_directory_patterns_are_distinct() {
        for (pattern, path, expected) in [
            ("docs/*", "docs/guide.md", true),
            ("docs/*", "docs/deep/guide.md", false),
            ("docs/**", "docs/deep/guide.md", true),
            ("/*.py", "main.py", true),
            ("/*.py", "src/main.py", false),
            ("*.py", "src/main.py", true),
            ("/apps/", "apps/main.py", true),
            ("/apps/", "nested/apps/main.py", false),
            ("apps/", "nested/apps/main.py", true),
            ("**/logs", "nested/logs/deep/run.log", true),
            ("apps/", "apps", false),
            ("src/**/test?.py", "src/deep/test1.py", true),
            ("src/**/test?.py", "src/test1.py", true),
            ("src/**/test?.py", "other/src/test1.py", false),
            ("[ab].py", "a.py", false),
            ("!secret.py", "secret.py", false),
        ] {
            assert_eq!(
                codeowners_pattern_matches(pattern, path),
                expected,
                "{pattern} vs {path}"
            );
        }
    }

    #[test]
    fn nested_file_keeps_broad_owner_when_immediate_children_rule_does_not_match() {
        let rules = parse_codeowners("* @general\ndocs/* @docs-top-level\n");
        assert_eq!(
            declared_owner("docs/guide.md", &rules).as_deref(),
            Some("@docs-top-level")
        );
        assert_eq!(
            declared_owner("docs/deep/guide.md", &rules).as_deref(),
            Some("@general")
        );
    }

    #[test]
    fn ownership_uses_reviewed_revision_not_checkout() {
        let root = tempfile::tempdir().unwrap();
        let git = git2::Repository::init(root.path()).unwrap();
        std::fs::write(root.path().join("CODEOWNERS"), "* @reviewed-team\n").unwrap();
        let mut index = git.index().unwrap();
        index.add_path(Path::new("CODEOWNERS")).unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = git.find_tree(tree_id).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let commit = git
            .commit(Some("HEAD"), &sig, &sig, "ownership fixture", &tree, &[])
            .unwrap();
        std::fs::write(root.path().join("CODEOWNERS"), "* @ambient-team\n").unwrap();
        let repo = Repository::open(root.path()).unwrap();
        let paths = vec!["src/main.rs".into()];
        assert_eq!(
            build_ownership_map_at_revision(&repo, &commit.to_string(), &paths),
            vec![("src/main.rs".into(), "@reviewed-team".into())]
        );
    }
}
