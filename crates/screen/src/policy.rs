//! What must never be captured. Matched on process name and window title, because
//! that is all that is known before pixels are read.

use crate::WindowInfo;

/// Password managers and private browsing, always on top of the user's own list.
pub const DEFAULT_EXCLUSIONS: &[&str] = &[
    "1password",
    "bitwarden",
    "keepass",
    "lastpass",
    "dashlane",
    "enpass",
    "nordpass",
    "credential manager",
    "inprivate",
    "incognito",
    "private browsing",
    "password",
    "windows security",
];

/// The rule that blocks this window, if any. Case-insensitive, and the built-in
/// list cannot be turned off by emptying the user's own.
pub fn exclusion_reason(window: &WindowInfo, user: &[String]) -> Option<String> {
    let process = window.process.to_lowercase();
    let title = window.title.to_lowercase();
    DEFAULT_EXCLUSIONS
        .iter()
        .map(|rule| rule.to_string())
        .chain(user.iter().map(|rule| rule.trim().to_lowercase()))
        .find(|rule| !rule.is_empty() && (process.contains(rule) || title.contains(rule)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(process: &str, title: &str) -> WindowInfo {
        WindowInfo { hwnd: 0, process: process.into(), title: title.into(), class: String::new() }
    }

    #[test]
    fn password_managers_are_always_blocked() {
        assert!(exclusion_reason(&window("1Password.exe", "Vault"), &[]).is_some());
        assert!(exclusion_reason(&window("KeePassXC.exe", "db"), &[]).is_some());
    }

    #[test]
    fn private_browsing_and_login_pages_are_blocked_by_title() {
        assert!(exclusion_reason(&window("msedge.exe", "Bank - InPrivate"), &[]).is_some());
        assert!(exclusion_reason(&window("chrome.exe", "Reset your password"), &[]).is_some());
    }

    #[test]
    fn the_users_own_rules_apply_too() {
        let rules = vec!["  Payroll ".to_string()];
        assert!(exclusion_reason(&window("excel.exe", "payroll 2026.xlsx"), &rules).is_some());
    }

    #[test]
    fn ordinary_work_is_allowed() {
        assert!(exclusion_reason(&window("code.exe", "main.rs - dock-agent"), &[]).is_none());
    }

    #[test]
    fn a_blank_rule_blocks_nothing() {
        assert!(exclusion_reason(&window("code.exe", "x"), &["   ".to_string()]).is_none());
    }
}
