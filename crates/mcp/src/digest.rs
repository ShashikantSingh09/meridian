//! What the server sent, turned into rows, and which tool may be called to get
//! it. All pure, and all of it treats the server as a stranger: tool lists,
//! annotations and results are data, and nothing in them is ever followed.

use serde_json::{json, Map, Value};

use crate::{Error, Item, Service};

const READ_PREFIXES: [&str; 8] = ["list", "search", "get", "find", "fetch", "read", "query", "retrieve"];
pub(crate) const WRITE_WORDS: [&str; 8] = ["delete", "remove", "send", "create", "update", "write", "post", "archive"];
const TEXT_PARAMS: [&str; 4] = ["query", "q", "search", "text"];
const COUNT_PARAMS: [&str; 6] = ["limit", "first", "max_results", "maxResults", "page_size", "pageSize"];
const PAGE_SIZE: u64 = 10;

const MAX_ROWS: usize = 50;
const MAX_FIELD_CHARS: usize = 240;
const MAX_TEXT_CHARS: usize = 4000;
const MAX_ERROR_CHARS: usize = 200;
const MAX_DEPTH: usize = 4;

const TITLE_FIELDS: [&str; 7] = ["title", "name", "subject", "summary", "identifier", "key", "displayName"];
const DETAIL_FIELDS: [&str; 7] = ["status", "state", "description", "snippet", "from", "email", "team"];
const URL_FIELDS: [&str; 6] = ["url", "html_url", "htmlUrl", "webViewLink", "link", "permalink"];
const WHEN_FIELDS: [&str; 8] = ["updatedAt", "updated_at", "createdAt", "created_at", "date", "due", "start", "timestamp"];
const KEY_FIELDS: [&str; 4] = ["id", "key", "url", "title"];

/// Annotations are hints from a server we do not trust, so the deny list beats
/// them. The name rule is only for catalogued services, whose naming we know.
pub(crate) fn readable(tool: &Value, catalogued: bool) -> bool {
    let Some(name) = tool["name"].as_str() else { return false };
    let name = name.to_ascii_lowercase();
    if WRITE_WORDS.iter().any(|word| name.contains(word)) {
        return false;
    }
    let annotations = &tool["annotations"];
    annotations["readOnlyHint"] == true
        || (catalogued
            && READ_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
            && annotations["destructiveHint"] != true)
}

fn has_type(property: &Value, wanted: &[&str]) -> bool {
    match &property["type"] {
        Value::String(kind) => wanted.contains(&kind.as_str()),
        // JSON Schema also allows ["string", "null"].
        Value::Array(kinds) => kinds.iter().any(|kind| kind.as_str().is_some_and(|kind| wanted.contains(&kind))),
        _ => false,
    }
}

/// The arguments that make this tool callable, or `None` when it needs
/// something only a person could supply.
pub(crate) fn arguments(tool: &Value) -> Option<Value> {
    let schema = &tool["inputSchema"];
    let empty = Map::new();
    let properties = schema["properties"].as_object().unwrap_or(&empty);
    let mut filled = Map::new();
    for (name, property) in properties {
        if COUNT_PARAMS.contains(&name.as_str()) && has_type(property, &["integer", "number"]) {
            filled.insert(name.clone(), json!(PAGE_SIZE));
        }
    }
    for name in schema["required"].as_array().into_iter().flatten() {
        let name = name.as_str()?;
        if filled.contains_key(name) {
            continue;
        }
        if !TEXT_PARAMS.contains(&name) || !has_type(properties.get(name)?, &["string"]) {
            return None;
        }
        filled.insert(name.to_string(), json!(""));
    }
    Some(Value::Object(filled))
}

/// Names in the catalog were picked by hand, so they need no read-sounding prefix.
fn picked(tool: &Value, service: Option<&Service>) -> bool {
    let named = service.is_some_and(|s| tool["name"].as_str().is_some_and(|name| s.prefer.contains(&name)));
    named && tool["annotations"]["destructiveHint"] != true
}

fn usable(tool: &Value, service: Option<&Service>) -> bool {
    (readable(tool, service.is_some()) || picked(tool, service)) && arguments(tool).is_some()
}

/// The names worth offering: anything else would only be refused.
pub(crate) fn usable_names(tools: &[Value], service: Option<&Service>) -> Vec<String> {
    tools
        .iter()
        .filter(|tool| usable(tool, service))
        .filter_map(|tool| tool["name"].as_str().map(str::to_string))
        .collect()
}

/// A tool and its arguments, or `None` when nothing here can be called. Only
/// an explicit request is refused out loud, because the user asked for it.
pub(crate) fn choose(
    tools: &[Value],
    service: Option<&Service>,
    wanted: Option<&str>,
) -> Result<Option<(String, Value)>, Error> {
    let usable = |tool: &&Value| usable(tool, service);
    let named = |name: &str| tools.iter().filter(usable).find(|tool| tool["name"] == name);
    let tool = match wanted {
        Some(name) => Some(named(name).ok_or_else(|| Error::ToolRefused(name.to_string()))?),
        None => service
            .into_iter()
            .flat_map(|service| service.prefer)
            .find_map(|name| named(name))
            .or_else(|| tools.iter().find(usable)),
    };
    Ok(tool.and_then(|tool| Some((tool["name"].as_str()?.to_string(), arguments(tool)?))))
}

fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Numbers count because ids often are, and a nested `{name}` is how most APIs
/// spell a status or an assignee.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Object(object) => object.get("name").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

fn first_of(row: &Map<String, Value>, fields: &[&str]) -> Option<String> {
    fields.iter().find_map(|field| text_of(row.get(*field)?)).map(|text| clip(&text, MAX_FIELD_CHARS))
}

/// Only http and https, so a row can never carry a `javascript:` or `file:`
/// link into the app.
fn web_link(row: &Map<String, Value>) -> Option<String> {
    URL_FIELDS.iter().find_map(|field| {
        let text = row.get(*field)?.as_str()?;
        let url = reqwest::Url::parse(text).ok()?;
        // The parsed form, which is plain ASCII: a lookalike character in the raw text
        // can read as one host here and turn into another once it reaches the browser.
        matches!(url.scheme(), "http" | "https").then(|| clip(url.as_str(), MAX_FIELD_CHARS))
    })
}

fn to_item(row: &Map<String, Value>) -> Option<Item> {
    let key = first_of(row, &KEY_FIELDS);
    let title = first_of(row, &TITLE_FIELDS).or_else(|| key.clone())?;
    Some(Item {
        key: key.unwrap_or_else(|| title.clone()),
        title,
        detail: first_of(row, &DETAIL_FIELDS),
        url: web_link(row),
        when: first_of(row, &WHEN_FIELDS),
    })
}

fn find_array(value: &Value, depth: usize, wanted: fn(&[Value]) -> bool) -> Option<&[Value]> {
    if depth > MAX_DEPTH {
        return None;
    }
    match value {
        Value::Array(items) if wanted(items) => Some(items),
        Value::Array(items) => items.iter().find_map(|child| find_array(child, depth + 1, wanted)),
        Value::Object(fields) => fields.values().find_map(|child| find_array(child, depth + 1, wanted)),
        _ => None,
    }
}

fn has_objects(items: &[Value]) -> bool {
    !items.is_empty() && items.iter().all(Value::is_object)
}

/// What a `tools/call` result has to show: rows if it holds a list, otherwise
/// its text. An empty list is a real answer, so it gives neither.
pub(crate) fn rows(result: &Value) -> Result<(Vec<Item>, Option<String>), Error> {
    let first_text = result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|block| block["type"] == "text")
        .and_then(|block| block["text"].as_str());
    if result["isError"] == true {
        return Err(Error::Tool(clip(first_text.unwrap_or("The tool failed."), MAX_ERROR_CHARS)));
    }
    let parsed: Option<Value> = first_text.and_then(|text| serde_json::from_str(text).ok());
    let structured = result.get("structuredContent").filter(|value| !value.is_null());
    let data = structured.or(parsed.as_ref()).unwrap_or(&Value::Null);
    let items: Vec<Item> = find_array(data, 0, has_objects)
        .into_iter()
        .flatten()
        .filter_map(|row| to_item(row.as_object()?))
        .take(MAX_ROWS)
        .collect();
    let nothing = items.is_empty() && find_array(data, 0, <[Value]>::is_empty).is_some();
    if !items.is_empty() || nothing {
        return Ok((items, None));
    }
    let text = first_text.map(str::to_string).or_else(|| (!data.is_null()).then(|| data.to_string()));
    Ok((items, text.map(|text| clip(&text, MAX_TEXT_CHARS))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Access;

    const SERVICE: Service = Service {
        id: "x",
        name: "X",
        group: "Work",
        blurb: "",
        url: "https://x.example",
        access: Access::Open,
        read_scopes: &[],
        prefer: &["second", "first_choice"],
    };

    fn tool(name: &str) -> Value {
        json!({ "name": name })
    }

    fn hinted(name: &str) -> Value {
        json!({ "name": name, "annotations": { "readOnlyHint": true } })
    }

    fn text_result(text: &str) -> Value {
        json!({ "content": [{ "type": "text", "text": text }] })
    }

    #[test]
    fn the_read_only_hint_is_enough_anywhere() {
        assert!(readable(&hinted("whoami"), false));
        assert!(readable(&hinted("whoami"), true));
    }

    #[test]
    fn a_read_only_hint_of_false_is_not_a_hint() {
        let tool = json!({ "name": "whoami", "annotations": { "readOnlyHint": false } });
        assert!(!readable(&tool, false));
        assert!(!readable(&tool, true));
    }

    #[test]
    fn name_prefixes_count_only_for_catalogued_services() {
        for name in ["list_issues", "search", "get_me", "find-tasks", "fetch_page", "read_file", "query_db", "retrieve_balance"] {
            assert!(readable(&tool(name), true), "{name}");
            assert!(!readable(&tool(name), false), "{name}");
        }
    }

    #[test]
    fn the_name_rule_ignores_case_and_wants_a_prefix() {
        assert!(readable(&tool("ListIssues"), true));
        assert!(!readable(&tool("whoami"), true));
        assert!(!readable(&tool("do_list"), true));
    }

    #[test]
    fn destructive_hint_cancels_the_name_rule() {
        let tool = json!({ "name": "get_and_clear", "annotations": { "destructiveHint": true } });
        assert!(!readable(&tool, true));
    }

    #[test]
    fn the_deny_list_beats_a_lying_annotation() {
        for name in ["delete_issue", "remove_user", "send_mail", "create_page", "update_issue", "write_file", "post_message", "archive_chat", "BulkDelete", "get_and_update"] {
            assert!(!readable(&hinted(name), true), "{name}");
            assert!(!readable(&hinted(name), false), "{name}");
        }
    }

    #[test]
    fn a_tool_without_a_name_is_not_readable() {
        assert!(!readable(&json!({ "annotations": { "readOnlyHint": true } }), true));
    }

    #[test]
    fn fills_required_text_and_count_parameters() {
        let tool = json!({
            "name": "search",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "first": { "type": "integer" },
                    "pageSize": { "type": "number" },
                    "offset": { "type": "integer" }
                },
                "required": ["query", "first"]
            }
        });
        assert_eq!(arguments(&tool), Some(json!({ "query": "", "first": 10, "pageSize": 10 })));
    }

    #[test]
    fn every_listed_name_fills() {
        for name in TEXT_PARAMS {
            let tool = json!({ "inputSchema": { "properties": { name: { "type": "string" } }, "required": [name] } });
            assert_eq!(arguments(&tool).unwrap()[name], "", "{name}");
        }
        for name in COUNT_PARAMS {
            let tool = json!({ "inputSchema": { "properties": { name: { "type": "integer" } }, "required": [name] } });
            assert_eq!(arguments(&tool).unwrap()[name], 10, "{name}");
        }
    }

    #[test]
    fn a_nullable_type_list_still_fills() {
        let tool = json!({ "inputSchema": { "properties": { "q": { "type": ["string", "null"] } }, "required": ["q"] } });
        assert_eq!(arguments(&tool), Some(json!({ "q": "" })));
    }

    #[test]
    fn no_schema_means_no_arguments() {
        assert_eq!(arguments(&tool("list")), Some(json!({})));
    }

    #[test]
    fn any_other_required_parameter_makes_a_tool_unusable() {
        let other = json!({ "inputSchema": { "properties": { "projectId": { "type": "string" } }, "required": ["projectId"] } });
        assert_eq!(arguments(&other), None);
        let wrong_type = json!({ "inputSchema": { "properties": { "query": { "type": "integer" } }, "required": ["query"] } });
        assert_eq!(arguments(&wrong_type), None);
        let string_limit = json!({ "inputSchema": { "properties": { "limit": { "type": "string" } }, "required": ["limit"] } });
        assert_eq!(arguments(&string_limit), None);
        let undeclared = json!({ "inputSchema": { "properties": {}, "required": ["query"] } });
        assert_eq!(arguments(&undeclared), None);
    }

    #[test]
    fn an_explicit_tool_must_itself_be_readable() {
        let tools = [hinted("delete_all"), hinted("list_all"), tool("plain")];
        assert!(matches!(choose(&tools, None, Some("delete_all")), Err(Error::ToolRefused(name)) if name == "delete_all"));
        assert!(matches!(choose(&tools, None, Some("plain")), Err(Error::ToolRefused(_))));
        assert!(matches!(choose(&tools, None, Some("absent")), Err(Error::ToolRefused(_))));
        assert_eq!(choose(&tools, None, Some("list_all")).unwrap().unwrap().0, "list_all");
    }

    #[test]
    fn an_explicit_tool_nobody_can_fill_is_refused() {
        let needs_id = json!({
            "name": "get_issue",
            "annotations": { "readOnlyHint": true },
            "inputSchema": { "properties": { "id": { "type": "string" } }, "required": ["id"] }
        });
        assert!(matches!(choose(&[needs_id], None, Some("get_issue")), Err(Error::ToolRefused(_))));
    }

    #[test]
    fn a_hand_picked_name_needs_no_read_prefix_but_stays_refusable() {
        let service = Service { prefer: &["notion-search"], ..SERVICE };
        let plain = json!({"name": "notion-search", "inputSchema": {}});
        assert!(usable(&plain, Some(&service)));
        assert!(!usable(&plain, None));
        let destructive = json!({"name": "notion-search", "annotations": {"destructiveHint": true}, "inputSchema": {}});
        assert!(!usable(&destructive, Some(&service)));
    }

    #[test]
    fn a_link_is_kept_in_its_ascii_form_so_it_cannot_change_host_later() {
        let row = json!({ "url": "https://evil.example\u{ff0f}@good.example/" });
        let link = web_link(row.as_object().unwrap()).unwrap();
        assert!(link.is_ascii(), "{link}");
    }

    #[test]
    fn prefer_order_beats_list_order() {
        let tools = [hinted("first_choice"), hinted("second")];
        assert_eq!(choose(&tools, Some(&SERVICE), None).unwrap().unwrap().0, "second");
    }

    #[test]
    fn a_preferred_tool_that_is_not_readable_is_passed_over() {
        let writes = json!({ "name": "second", "annotations": { "destructiveHint": true } });
        let tools = [writes, hinted("first_choice")];
        assert_eq!(choose(&tools, Some(&SERVICE), None).unwrap().unwrap().0, "first_choice");
    }

    #[test]
    fn a_preferred_tool_with_unfillable_parameters_is_passed_over() {
        let needs_id = json!({
            "name": "second",
            "annotations": { "readOnlyHint": true },
            "inputSchema": { "properties": { "id": { "type": "string" } }, "required": ["id"] }
        });
        let tools = [needs_id, hinted("first_choice")];
        assert_eq!(choose(&tools, Some(&SERVICE), None).unwrap().unwrap().0, "first_choice");
    }

    #[test]
    fn without_a_preference_the_first_usable_tool_wins() {
        let needs_id = json!({
            "name": "get_one",
            "annotations": { "readOnlyHint": true },
            "inputSchema": { "properties": { "id": { "type": "string" } }, "required": ["id"] }
        });
        let tools = [tool("create_thing"), needs_id, hinted("list_things"), hinted("list_others")];
        let (name, arguments) = choose(&tools, None, None).unwrap().unwrap();
        assert_eq!(name, "list_things");
        assert_eq!(arguments, json!({}));
    }

    #[test]
    fn nothing_readable_means_nothing_chosen_rather_than_an_error() {
        assert!(choose(&[tool("whoami")], Some(&SERVICE), None).unwrap().is_none());
        assert!(choose(&[], None, None).unwrap().is_none());
    }

    #[test]
    fn only_callable_names_are_offered() {
        let needs_id = json!({
            "name": "get_one",
            "annotations": { "readOnlyHint": true },
            "inputSchema": { "properties": { "id": { "type": "string" } }, "required": ["id"] }
        });
        let tools = [hinted("list_a"), hinted("delete_b"), tool("get_c"), needs_id];
        assert_eq!(usable_names(&tools, None), ["list_a"]);
        assert_eq!(usable_names(&tools, Some(&SERVICE)), ["list_a", "get_c"]);
    }

    #[test]
    fn structured_content_wins_over_text() {
        let result = json!({
            "structuredContent": { "issues": [{ "id": "A", "title": "From structure" }] },
            "content": [{ "type": "text", "text": "[{\"id\":\"B\",\"title\":\"From text\"}]" }]
        });
        assert_eq!(rows(&result).unwrap().0[0].title, "From structure");
    }

    #[test]
    fn a_null_structure_is_no_structure() {
        let mut result = text_result(r#"[{"id":"B"}]"#);
        result["structuredContent"] = Value::Null;
        assert_eq!(rows(&result).unwrap().0[0].key, "B");
    }

    #[test]
    fn the_first_text_block_is_parsed_when_there_is_no_structure() {
        let result = json!({ "content": [
            { "type": "image", "data": "xx" },
            { "type": "text", "text": "{\"items\":[{\"id\":1,\"name\":\"One\"}]}" },
            { "type": "text", "text": "[{\"id\":2,\"name\":\"Two\"}]" }
        ] });
        let (items, text) = rows(&result).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].key, "1");
        assert_eq!(items[0].title, "One");
        assert_eq!(text, None);
    }

    #[test]
    fn every_field_is_picked_from_its_own_list() {
        let result = text_result(
            &json!([{
                "id": "ENG-1",
                "subject": "Fix it",
                "state": { "name": "In Progress", "color": "#fff" },
                "htmlUrl": "https://example.test/ENG-1",
                "updated_at": "2026-10-30T10:00:00Z"
            }])
            .to_string(),
        );
        let (items, _) = rows(&result).unwrap();
        assert_eq!(
            items,
            [Item {
                key: "ENG-1".to_string(),
                title: "Fix it".to_string(),
                detail: Some("In Progress".to_string()),
                url: Some("https://example.test/ENG-1".to_string()),
                when: Some("2026-10-30T10:00:00Z".to_string()),
            }]
        );
    }

    #[test]
    fn field_lists_keep_their_priority() {
        let row = json!({
            "displayName": "Late", "title": "Early",
            "team": "Late", "status": "Early",
            "due": "Late", "updatedAt": "Early"
        });
        let result = json!({ "structuredContent": [row] });
        let item = &rows(&result).unwrap().0[0];
        assert_eq!(item.title, "Early");
        assert_eq!(item.detail.as_deref(), Some("Early"));
        assert_eq!(item.when.as_deref(), Some("Early"));
    }

    #[test]
    fn a_row_keyed_by_nothing_but_its_title_still_shows() {
        let item = &rows(&json!({ "structuredContent": [{ "title": "Only" }] })).unwrap().0[0];
        assert_eq!(item.key, "Only");
    }

    #[test]
    fn a_row_with_an_id_and_no_title_shows_the_id() {
        let item = &rows(&json!({ "structuredContent": [{ "id": 7 }] })).unwrap().0[0];
        assert_eq!(item.title, "7");
    }

    #[test]
    fn links_other_than_web_ones_are_dropped() {
        for bad in ["javascript:alert(1)", "file:///c:/windows", "data:text/html,hi", "not a url"] {
            let result = json!({ "structuredContent": [{ "id": 1, "url": bad }] });
            assert_eq!(rows(&result).unwrap().0[0].url, None, "{bad}");
        }
    }

    #[test]
    fn a_bad_link_does_not_hide_a_good_one_in_a_later_field() {
        let result = json!({ "structuredContent": [{ "id": 1, "url": "javascript:x", "permalink": "http://example.test/1" }] });
        assert_eq!(rows(&result).unwrap().0[0].url.as_deref(), Some("http://example.test/1"));
    }

    #[test]
    fn rows_stop_at_the_cap() {
        let many: Vec<Value> = (0..70).map(|index| json!({ "id": index })).collect();
        assert_eq!(rows(&json!({ "structuredContent": many })).unwrap().0.len(), 50);
    }

    #[test]
    fn strings_are_cut_on_a_character_boundary() {
        let long = "é".repeat(300);
        let result = json!({ "structuredContent": [{ "id": long, "title": long, "status": long, "date": long }] });
        let item = &rows(&result).unwrap().0[0];
        assert_eq!(item.key.chars().count(), 240);
        assert_eq!(item.title.chars().count(), 240);
        assert_eq!(item.detail.as_ref().unwrap().chars().count(), 240);
        assert_eq!(item.when.as_ref().unwrap().chars().count(), 240);
    }

    #[test]
    fn long_links_are_cut_too() {
        let url = format!("https://example.test/{}", "a".repeat(300));
        let result = json!({ "structuredContent": [{ "id": 1, "url": url }] });
        assert_eq!(rows(&result).unwrap().0[0].url.as_ref().unwrap().chars().count(), 240);
    }

    #[test]
    fn finds_the_array_four_levels_down_and_no_further() {
        let row = json!([{ "id": 1 }]);
        let four = json!({ "a": { "b": { "c": { "d": row } } } });
        assert_eq!(rows(&json!({ "structuredContent": four })).unwrap().0.len(), 1);
        let five = json!({ "a": { "b": { "c": { "d": { "e": row } } } } });
        let (items, text) = rows(&json!({ "structuredContent": five })).unwrap();
        assert!(items.is_empty());
        assert!(text.unwrap().contains("\"id\":1"));
    }

    #[test]
    fn an_array_of_scalars_is_skipped_for_the_array_of_objects_after_it() {
        let data = json!({ "a_labels": ["x", "y"], "b_rows": [{ "id": 1 }] });
        assert_eq!(rows(&json!({ "structuredContent": data })).unwrap().0.len(), 1);
    }

    #[test]
    fn an_empty_array_does_not_hide_a_full_one() {
        let data = json!({ "a_errors": [], "b_rows": [{ "id": 1 }] });
        assert_eq!(rows(&json!({ "structuredContent": data })).unwrap().0.len(), 1);
    }

    #[test]
    fn an_empty_list_is_an_empty_answer_and_not_text() {
        let (items, text) = rows(&text_result(r#"{"issues":[]}"#)).unwrap();
        assert!(items.is_empty());
        assert_eq!(text, None);
    }

    #[test]
    fn plain_text_comes_back_as_text_within_the_limit() {
        let (items, text) = rows(&text_result(&"é".repeat(5000))).unwrap();
        assert!(items.is_empty());
        assert_eq!(text.unwrap().chars().count(), 4000);
    }

    #[test]
    fn json_with_no_array_comes_back_as_text() {
        let (_, text) = rows(&text_result(r#"{"name":"Ada"}"#)).unwrap();
        assert_eq!(text.as_deref(), Some(r#"{"name":"Ada"}"#));
    }

    #[test]
    fn objects_with_nothing_to_show_fall_back_to_the_text() {
        let (items, text) = rows(&text_result(r#"[{"colour":"red"}]"#)).unwrap();
        assert!(items.is_empty());
        assert!(text.unwrap().contains("colour"));
    }

    #[test]
    fn is_error_becomes_a_short_error() {
        let mut result = text_result(&"x".repeat(500));
        result["isError"] = json!(true);
        let Err(Error::Tool(message)) = rows(&result) else { panic!("expected a tool error") };
        assert_eq!(message.chars().count(), 200);
    }

    #[test]
    fn is_error_wins_even_with_rows_in_the_result() {
        let result = json!({ "isError": true, "structuredContent": [{ "id": 1 }], "content": [] });
        assert!(matches!(rows(&result), Err(Error::Tool(_))));
    }

    #[test]
    fn an_empty_result_is_nothing_at_all() {
        assert_eq!(rows(&json!({ "content": [] })).unwrap(), (Vec::new(), None));
    }
}
