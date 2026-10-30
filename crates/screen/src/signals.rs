//! Observable signs that something went wrong, read from on-screen text. These
//! say what is visible and never guess how the user feels. Runs on this machine.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SignalKind {
    Terraform,
    CloudPermission,
    Kubernetes,
    Build,
    Runtime,
    Network,
    Package,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub kind: SignalKind,
    pub title: String,
    /// The line that matched, so the suggestion quotes what is actually there.
    pub evidence: String,
}

struct Rule {
    kind: SignalKind,
    title: &'static str,
    /// Lowercased. A line matches when it contains any of these.
    any: &'static [&'static str],
    /// If set, this must also appear somewhere in the text. Keeps a word like
    /// "error" in ordinary prose from firing.
    context: &'static [&'static str],
}

const RULES: &[Rule] = &[
    Rule {
        kind: SignalKind::Terraform,
        title: "Looks like a Terraform configuration issue",
        any: &["error:", "planning failed", "apply failed"],
        context: &["terraform", ".tf line", "main.tf", "on main.tf", "provider registry"],
    },
    Rule {
        kind: SignalKind::CloudPermission,
        title: "A cloud permission was denied",
        any: &[
            "accessdenied",
            "access denied",
            "is not authorized to perform",
            "authorizationfailed",
            "does not have authorization",
            "permissiondenied",
            "unauthorizedoperation",
        ],
        context: &["aws", "iam", "arn:", "azure", "gcloud", "subscription", "s3", "role"],
    },
    Rule {
        kind: SignalKind::Kubernetes,
        title: "A Kubernetes workload is failing",
        any: &["crashloopbackoff", "imagepullbackoff", "errimagepull", "oomkilled", "forbidden: user"],
        context: &[],
    },
    Rule {
        kind: SignalKind::Build,
        title: "A build failed",
        any: &[
            "build failed",
            "compilation failed",
            "could not compile",
            "error[e0",
            "error ts",
            "failed to compile",
            "linker command failed",
            "fatal error c",
        ],
        context: &[],
    },
    Rule {
        kind: SignalKind::Runtime,
        title: "A program crashed",
        any: &[
            "traceback (most recent call last)",
            "unhandled exception",
            "nullreferenceexception",
            "exception in thread",
            "panicked at",
            "segmentation fault",
            "typeerror: cannot read",
        ],
        context: &[],
    },
    Rule {
        kind: SignalKind::Network,
        title: "A connection failed",
        any: &["econnrefused", "connection refused", "etimedout", "503 service unavailable", "certificate verify failed"],
        context: &[],
    },
    Rule {
        kind: SignalKind::Package,
        title: "A package install failed",
        any: &["npm err!", "pip subprocess", "could not find a version", "cannot find module", "modulenotfounderror"],
        context: &[],
    },
];

/// Windows OCR reads file names with a gap, as in `main. tf`. Closing it affects
/// matching only: what the user sees and shares stays as it was read.
fn tighten(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, c) in chars.iter().enumerate() {
        let gap = *c == ' '
            && i >= 2
            && chars[i - 1] == '.'
            && chars[i - 2].is_alphanumeric()
            && chars.get(i + 1).is_some_and(|next| next.is_alphanumeric());
        if !gap {
            out.push(*c);
        }
    }
    out
}

/// Every distinct signal in a block of OCR text, at most one per kind.
pub fn detect(text: &str) -> Vec<Signal> {
    let lower = tighten(&text.to_lowercase());
    let mut found = Vec::new();
    for rule in RULES {
        if !rule.context.is_empty() && !rule.context.iter().any(|c| lower.contains(c)) {
            continue;
        }
        let hit = text.lines().find(|line| {
            let line = line.to_lowercase();
            rule.any.iter().any(|needle| line.contains(needle))
        });
        if let Some(line) = hit {
            found.push(Signal {
                kind: rule.kind,
                title: rule.title.to_string(),
                evidence: line.trim().chars().take(200).collect(),
            });
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_a_terraform_error_and_quotes_it() {
        let text = "terraform plan\nError: Invalid reference\n  on main.tf line 12, in resource";
        let signals = detect(text);
        assert_eq!(signals[0].kind, SignalKind::Terraform);
        assert_eq!(signals[0].evidence, "Error: Invalid reference");
    }

    #[test]
    fn survives_the_gap_ocr_puts_in_file_names() {
        let text = "Error: Invalid reference\non main. tf line 12";
        assert_eq!(detect(text)[0].kind, SignalKind::Terraform);
        assert_eq!(tighten("on main. tf line. Next"), "on main.tf line.Next");
    }

    #[test]
    fn recognises_an_iam_denial() {
        let text = "An error occurred (AccessDenied) when calling PutObject\nUser: arn:aws:iam::1:user/a is not authorized to perform: s3:PutObject";
        assert_eq!(detect(text)[0].kind, SignalKind::CloudPermission);
    }

    #[test]
    fn recognises_rust_and_typescript_build_failures() {
        assert_eq!(detect("error[E0432]: unresolved import")[0].kind, SignalKind::Build);
        assert_eq!(detect("src/a.ts(3,1): error TS2339: nope")[0].kind, SignalKind::Build);
    }

    #[test]
    fn recognises_a_python_traceback() {
        assert_eq!(detect("Traceback (most recent call last):\n  File x")[0].kind, SignalKind::Runtime);
    }

    #[test]
    fn the_word_error_in_ordinary_text_does_nothing() {
        for text in [
            "How to handle an error: a guide for writers",
            "We regret the error in yesterday's article.",
            "Terror: the novel",
            "access denied is a great film title",
        ] {
            assert!(detect(text).is_empty(), "{text}");
        }
    }

    #[test]
    fn terraform_needs_terraform_context() {
        assert!(detect("Error: something odd happened").is_empty());
    }

    #[test]
    fn reports_each_kind_once() {
        let text = "BUILD FAILED\ncould not compile\nerror[E0308]: mismatched types";
        assert_eq!(detect(text).len(), 1);
    }

    #[test]
    fn empty_text_is_fine() {
        assert!(detect("").is_empty());
    }
}
