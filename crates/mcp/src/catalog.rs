//! Every remote server the app ships with. Adding one that signs in the usual
//! way is a new row here and nothing else.

use serde::Serialize;

/// What connecting takes. The real flow, run as far as the browser on 2026-11-01,
/// sorted the rows. None of this was tried with a real account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    /// The server registers us on the spot, so there is nothing to set up.
    Open,
    /// The vendor only accepts an app the user registered with them.
    RegisteredApp,
    /// A pasted personal access token, or a registered app.
    TokenOrApp,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: &'static str,
    pub name: &'static str,
    pub group: &'static str,
    pub blurb: &'static str,
    pub url: &'static str,
    pub access: Access,
    /// Empty means the server decides, usually through its own consent screen.
    pub read_scopes: &'static [&'static str],
    /// Best guesses at tool names, because listing tools needs a login. A guess
    /// that misses only costs the fallback, and a tool here still has to pass
    /// the read-only check.
    pub prefer: &'static [&'static str],
}

const fn open(
    id: &'static str,
    name: &'static str,
    group: &'static str,
    blurb: &'static str,
    url: &'static str,
    read_scopes: &'static [&'static str],
    prefer: &'static [&'static str],
) -> Service {
    Service { id, name, group, blurb, url, access: Access::Open, read_scopes, prefer }
}

const fn app(
    id: &'static str,
    name: &'static str,
    group: &'static str,
    blurb: &'static str,
    url: &'static str,
    read_scopes: &'static [&'static str],
    prefer: &'static [&'static str],
) -> Service {
    Service { access: Access::RegisteredApp, ..open(id, name, group, blurb, url, read_scopes, prefer) }
}

#[rustfmt::skip]
static CATALOG: [Service; 22] = [
    open("linear", "Linear", "Work", "Issues assigned to you.", "https://mcp.linear.app/mcp", &["read"], &["list_my_issues", "list_issues"]),
    open("notion", "Notion", "Work", "Pages from your workspace.", "https://mcp.notion.com/mcp", &[], &["notion-search", "search"]),
    open("atlassian", "Jira and Confluence", "Work", "Issues and pages you can see.", "https://mcp.atlassian.com/v1/mcp", &[], &["search", "searchJiraIssuesUsingJql"]),
    open("clickup", "ClickUp", "Work", "Tasks from your workspace.", "https://mcp.clickup.com/mcp", &["read"], &["clickup_search"]),
    open("monday", "monday.com", "Work", "Boards and items you follow.", "https://mcp.monday.com/mcp", &[], &[]),
    open("todoist", "Todoist", "Work", "Tasks on your list.", "https://ai.todoist.net/mcp", &["data:read"], &["find-tasks", "get-overview"]),
    open("airtable", "Airtable", "Work", "Bases you can open.", "https://mcp.airtable.com/mcp", &["schema.bases:read", "data.records:read", "workspacesAndBases:read"], &["list_bases"]),
    open("intercom", "Intercom", "Customers", "Recent customer conversations.", "https://mcp.intercom.com/mcp", &[], &["search_conversations"]),
    open("granola", "Granola", "Work", "Your recent meeting notes.", "https://mcp.granola.ai/mcp", &[], &["list_meetings"]),
    open("sentry", "Sentry", "Development", "Open issues from your projects.", "https://mcp.sentry.dev/mcp", &["org:read"], &["find_issues", "search_issues"]),
    open("vercel", "Vercel", "Development", "Recent deployments and projects.", "https://mcp.vercel.com", &[], &["list_deployments", "list_projects"]),
    app("figma", "Figma", "Design", "The account you signed in with.", "https://mcp.figma.com/mcp", &[], &["whoami"]),
    open("canva", "Canva", "Design", "Designs in your folders.", "https://mcp.canva.com/mcp", &["profile:read", "design:meta:read", "folder:read"], &["list-folder-items"]),
    open("dropbox", "Dropbox", "Files", "Files in your Dropbox.", "https://mcp.dropbox.com/mcp", &["account_info.read", "files.metadata.read"], &["list_folder"]),
    open("stripe", "Stripe", "Payments", "Customers and your balance.", "https://mcp.stripe.com", &[], &["list_customers", "retrieve_balance"]),
    open("paypal", "PayPal", "Payments", "Invoices on your account.", "https://mcp.paypal.com/mcp", &[], &["list_invoices"]),
    app("slack", "Slack", "Work", "Channels you belong to.", "https://mcp.slack.com/mcp", &["channels:read", "groups:read", "users:read"], &["list_channels"]),
    app("asana", "Asana", "Work", "Tasks assigned to you.", "https://mcp.asana.com/v2/mcp", &[], &["get_my_tasks"]),
    app("hubspot", "HubSpot", "Customers", "Contacts and deals from your CRM.", "https://mcp.hubspot.com/", &[], &["search_crm_objects"]),
    app("box", "Box", "Files", "Files in your Box folders.", "https://mcp.box.com", &[], &["list_folder_items"]),
    app("drive", "Google Drive", "Files", "Files you opened recently.", "https://drivemcp.googleapis.com/mcp/v1", &["https://www.googleapis.com/auth/drive.readonly"], &["search_files", "list_recent_files"]),
    Service {
        access: Access::TokenOrApp,
        ..app("github", "GitHub", "Development", "Notifications and issues for you.", "https://api.githubcopilot.com/mcp/", &["notifications", "read:user"], &["list_notifications", "list_issues"])
    },
];

pub fn catalog() -> &'static [Service] {
    &CATALOG
}

pub fn find(id: &str) -> Option<&'static Service> {
    CATALOG.iter().find(|service| service.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::check_url;

    #[test]
    fn ids_are_unique_and_findable() {
        for service in catalog() {
            assert_eq!(find(service.id).unwrap().url, service.url);
        }
        assert!(find("nothing").is_none());
    }

    #[test]
    fn every_row_passes_the_guard_it_will_be_held_to() {
        for service in catalog() {
            assert!(check_url(service.url, false).is_ok(), "{}", service.id);
            assert!(!service.blurb.is_empty(), "{}", service.id);
        }
    }

    #[test]
    fn access_kinds_are_sorted_as_probed() {
        assert_eq!(find("linear").unwrap().access, Access::Open);
        assert_eq!(find("slack").unwrap().access, Access::RegisteredApp);
        assert_eq!(find("github").unwrap().access, Access::TokenOrApp);
        assert_eq!(catalog().iter().filter(|service| service.access == Access::Open).count(), 15);
    }

    #[test]
    fn access_serializes_in_camel_case() {
        assert_eq!(serde_json::to_string(&Access::RegisteredApp).unwrap(), r#""registeredApp""#);
        let row = serde_json::to_value(find("linear").unwrap()).unwrap();
        assert_eq!(row["readScopes"][0], "read");
    }
}
