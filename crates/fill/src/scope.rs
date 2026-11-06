//! Which of the boxes read are the form the user is working in. A sign-up page also has a search box
//! in its header, sometimes a login there too, a newsletter box in its footer, a cookie banner and a
//! chat bubble, and none of them is the form. Everything here works on places and words only, so it
//! is proved without a window, and a Mac reader can use it as it is.
//!
//! The rule: the form, dialog or frame around the cursor, all of it. With no cursor in one, the box
//! with the cursor and the boxes near it. With no cursor in a box, the biggest form, dialog or group
//! of boxes near one another, counting only boxes that are not search, newsletter, chat, cookie,
//! header, menu or footer boxes. A dialog with two boxes or more is in front, so it wins.

use crate::model::{has_any, words, Bounds, Field, FieldKind};

/// A part of the page that tells where a box belongs, from the page's own roles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Part {
    Form,
    Dialog,
    /// A page inside the page: an iframe.
    Frame,
    Search,
    /// The page's header.
    Banner,
    Navigation,
    /// The page's footer.
    Footer,
    /// A sidebar.
    Aside,
    /// A named section, such as a cookie banner.
    Region,
}

impl Part {
    /// From the web role Chrome, Edge and Firefox give, in every language.
    pub(crate) fn from_role(role: &str) -> Option<Part> {
        Some(match role {
            "form" => Part::Form,
            "dialog" | "alertdialog" => Part::Dialog,
            "document" => Part::Frame,
            "search" => Part::Search,
            "banner" => Part::Banner,
            "navigation" => Part::Navigation,
            "contentinfo" => Part::Footer,
            "complementary" => Part::Aside,
            "region" => Part::Region,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Region {
    pub part: Part,
    pub name: String,
    pub bounds: Bounds,
}

/// A box as read, with what only the reader knows about it.
#[derive(Debug, Clone)]
pub(crate) struct Seen {
    pub field: Field,
    /// The page calls it a search box: `<input type=search>` or role=searchbox.
    pub searchbox: bool,
}

/// How far a box is from the form a person means, worst last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Noise {
    None,
    /// Its own words say search, newsletter or chat. It may still sit inside the form.
    Words,
    /// In the page's header, menu, footer or sidebar.
    Edge,
    /// A search box, or in a search, cookie, chat or newsletter part.
    Elsewhere,
}

// Lowercase whole words, as `model::words` writes them.
const NOISE_WORDS: &[&str] = &[
    "search", "newsletter", "subscribe", "chat", "type a message", "write a message", "type your message",
    "खोजें", "खोज", "सर्च", "न्यूज़लेटर", "न्यूजलेटर",
];
const NOISE_NAMES: &[&str] = &[
    "search", "cookie", "cookies", "consent", "privacy preference", "chat", "messenger", "newsletter",
    "subscribe", "खोज", "कुकी", "न्यूज़लेटर",
];

/// Inside, give or take two pixels for rounding.
pub(crate) fn holds(outer: &Bounds, inner: &Bounds) -> bool {
    outer.big_enough()
        && inner.x >= outer.x - 2
        && inner.y >= outer.y - 2
        && inner.x + inner.width <= outer.x + outer.width + 2
        && inner.y + inner.height <= outer.y + outer.height + 2
}

fn area(at: &Bounds) -> i64 {
    at.width as i64 * at.height as i64
}

/// A form or frame that holds the page's header, menu, footer or search is the whole page, as
/// ASP.NET pages wrap everything in one form. It says nothing about which boxes go together.
fn whole_page(region: &Region, regions: &[Region]) -> bool {
    matches!(region.part, Part::Form | Part::Frame)
        && regions.iter().any(|other| {
            matches!(other.part, Part::Banner | Part::Navigation | Part::Footer | Part::Search) && holds(&region.bounds, &other.bounds)
        })
}

fn noise(seen: &Seen, regions: &[Region]) -> Noise {
    let at = &seen.field.bounds;
    let mut worst = if has_any(&seen.field.words(), NOISE_WORDS) { Noise::Words } else { Noise::None };
    if seen.searchbox {
        worst = Noise::Elsewhere;
    }
    for region in regions.iter().filter(|region| holds(&region.bounds, at)) {
        let named = has_any(&words(&region.name), NOISE_NAMES);
        let here = match region.part {
            Part::Search => Noise::Elsewhere,
            _ if named => Noise::Elsewhere,
            Part::Banner | Part::Navigation | Part::Footer | Part::Aside => Noise::Edge,
            _ => Noise::None,
        };
        worst = worst.max(here);
    }
    worst
}

/// The height of a one-line box on this page, in its pixels, so nearness scales with zoom and DPI.
fn unit(seen: &[Seen]) -> i32 {
    let mut heights: Vec<i32> = seen
        .iter()
        .filter(|seen| !matches!(seen.field.kind, FieldKind::MultiLine | FieldKind::RichText | FieldKind::Checkbox | FieldKind::Radio))
        .map(|seen| seen.field.bounds.height)
        .collect();
    heights.sort_unstable();
    heights.get(heights.len() / 2).copied().unwrap_or(32).clamp(12, 120)
}

/// Near enough to be one form: within three box heights across and down.
// ponytail: a guess from common layouts (rows 1 to 2.5 heights apart, a page's header 4 or more
// above its form). Tune it with the by-hand tests if real pages split or merge.
fn near(a: &Bounds, b: &Bounds, unit: i32) -> bool {
    let gap = |a0: i32, a1: i32, b0: i32, b1: i32| (b0 - a1).max(a0 - b1).max(0);
    gap(a.x, a.x + a.width, b.x, b.x + b.width) <= 3 * unit && gap(a.y, a.y + a.height, b.y, b.y + b.height) <= 3 * unit
}

/// Groups of boxes near one another, by single linkage, each in page order.
// ponytail: n² comparisons, fine for the few hundred boxes a page shows at once.
fn clusters(seen: &[Seen], members: &[usize], unit: i32) -> Vec<Vec<usize>> {
    let mut group: Vec<usize> = (0..members.len()).collect();
    fn top(group: &mut [usize], mut at: usize) -> usize {
        while group[at] != at {
            group[at] = group[group[at]];
            at = group[at];
        }
        at
    }
    for a in 0..members.len() {
        for b in a + 1..members.len() {
            if near(&seen[members[a]].field.bounds, &seen[members[b]].field.bounds, unit) {
                let (ta, tb) = (top(&mut group, a), top(&mut group, b));
                group[ta.max(tb)] = ta.min(tb);
            }
        }
    }
    let mut out: Vec<Vec<usize>> = Vec::new();
    let mut tops: Vec<usize> = Vec::new();
    for (at, &member) in members.iter().enumerate() {
        let t = top(&mut group, at);
        match tops.iter().position(|&known| known == t) {
            Some(known) => out[known].push(member),
            None => {
                tops.push(t);
                out.push(vec![member]);
            }
        }
    }
    out
}

/// The boxes to keep from a group of near boxes: the ones that are not header, menu or footer boxes,
/// unless that is all there is, and the search-like boxes that sit among them ("Search your college").
fn tidy(seen: &[Seen], noise: &[Noise], home: &[Option<usize>], group: &[usize], unit: i32, keep_too: Option<usize>) -> Vec<usize> {
    let plain: Vec<usize> = group.iter().copied().filter(|&at| noise[at] == Noise::None || Some(at) == keep_too).collect();
    let mut kept = if plain.is_empty() { group.to_vec() } else { plain };
    let hull = kept.iter().map(|&at| seen[at].field.bounds).reduce(|a, b| {
        let (x, y) = (a.x.min(b.x), a.y.min(b.y));
        Bounds { x, y, width: (a.x + a.width).max(b.x + b.width) - x, height: (a.y + a.height).max(b.y + b.height) - y }
    });
    if let Some(hull) = hull {
        let hull = Bounds { x: hull.x - unit, y: hull.y - unit, width: hull.width + 2 * unit, height: hull.height + 2 * unit };
        kept.extend((0..seen.len()).filter(|&at| noise[at] == Noise::Words && home[at].is_none() && holds(&hull, &seen[at].field.bounds)));
    }
    kept.sort_unstable();
    kept.dedup();
    kept
}

/// The places in `seen` of the boxes that are the form in front, in page order. `focus` is where
/// the keyboard cursor is, box or not; None when it is on no part of the page.
pub(crate) fn pick(seen: &[Seen], regions: &[Region], focus: Option<Bounds>) -> Vec<usize> {
    let containers: Vec<&Region> = regions
        .iter()
        .filter(|region| matches!(region.part, Part::Form | Part::Dialog | Part::Frame | Part::Search) && !whole_page(region, regions))
        .collect();
    // The smallest form, dialog or frame around a place.
    let innermost = |at: &Bounds| (0..containers.len()).filter(|&c| holds(&containers[c].bounds, at)).min_by_key(|&c| area(&containers[c].bounds));
    let home: Vec<Option<usize>> = seen.iter().map(|seen| innermost(&seen.field.bounds)).collect();
    let noise: Vec<Noise> = seen.iter().map(|seen| noise(seen, regions)).collect();
    let unit = unit(seen);
    let inside = |c: usize| (0..seen.len()).filter(|&at| holds(&containers[c].bounds, &seen[at].field.bounds)).collect::<Vec<_>>();
    // Boxes in no form, dialog or frame, grouped by nearness. Search and chat boxes never join.
    let loose = |also: Option<usize>| {
        let joins = |at: usize| matches!(noise[at], Noise::None | Noise::Edge) || Some(at) == also;
        let members: Vec<usize> = (0..seen.len()).filter(|&at| home[at].is_none() && joins(at)).collect();
        clusters(seen, &members, unit)
    };

    if let Some(focus) = focus {
        let focused = seen.iter().position(|seen| seen.field.bounds == focus);
        // The cursor's form, dialog or frame: all of it, whatever its boxes are called.
        if let Some(c) = focused.map_or_else(|| innermost(&focus), |at| home[at]) {
            return inside(c);
        }
        if let Some(at) = focused {
            let group = loose(Some(at)).into_iter().find(|group| group.contains(&at)).unwrap_or_else(|| vec![at]);
            return tidy(seen, &noise, &home, &group, unit, Some(at));
        }
    }

    // No cursor in a form: the biggest one, counting boxes that are no one's noise first.
    let score = |group: &[usize]| {
        let plain = group.iter().filter(|&&at| noise[at] == Noise::None).count();
        let edge = group.iter().filter(|&&at| noise[at] == Noise::Edge).count();
        (plain, plain + edge)
    };
    let dialog = (0..containers.len())
        .filter(|&c| containers[c].part == Part::Dialog)
        .map(|c| (c, score(&(0..seen.len()).filter(|&at| home[at] == Some(c)).collect::<Vec<_>>())))
        .filter(|(_, (plain, _))| *plain >= 2)
        .max_by_key(|(_, score)| *score);
    if let Some((c, _)) = dialog {
        return inside(c);
    }
    let mut best: Option<((usize, usize), Vec<usize>)> = None;
    for c in 0..containers.len() {
        let group: Vec<usize> = (0..seen.len()).filter(|&at| home[at] == Some(c)).collect();
        let score = score(&group);
        if score.1 > 0 && best.as_ref().is_none_or(|(known, _)| score > *known) {
            best = Some((score, inside(c)));
        }
    }
    for group in loose(None) {
        let score = score(&group);
        if score.1 > 0 && best.as_ref().is_none_or(|(known, _)| score > *known) {
            best = Some((score, tidy(seen, &noise, &home, &group, unit, None)));
        }
    }
    best.map(|(_, kept)| kept).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::field;

    fn at(x: i32, y: i32, width: i32, height: i32) -> Bounds {
        Bounds { x, y, width, height }
    }

    fn seen(label: &str, kind: FieldKind, bounds: Bounds) -> Seen {
        Seen { field: Field { bounds, ..field(0, label, kind) }, searchbox: false }
    }

    fn region(part: Part, name: &str, bounds: Bounds) -> Region {
        Region { part, name: name.into(), bounds }
    }

    fn labels(seen: &[Seen], kept: &[usize]) -> Vec<String> {
        kept.iter().map(|&at| seen[at].field.label.clone()).collect()
    }

    /// A sign-up page as Meridian reads it: a header with search and a login, a cookie banner, the
    /// form in two columns, a footer newsletter and an open chat bubble.
    fn signup() -> (Vec<Seen>, Vec<Region>) {
        let mut search = seen("Search jobs", FieldKind::PlainText, at(600, 20, 300, 36));
        search.searchbox = true;
        let boxes = vec![
            search,
            seen("Email", FieldKind::Email, at(1300, 20, 160, 36)),
            seen("Password", FieldKind::Password, at(1470, 20, 160, 36)),
            seen("Analytics", FieldKind::Checkbox, at(1500, 900, 40, 20)),
            seen("Full name *", FieldKind::PlainText, at(500, 300, 400, 40)),
            seen("Email ID *", FieldKind::Email, at(920, 300, 400, 40)),
            seen("Password *", FieldKind::Password, at(500, 380, 400, 40)),
            seen("Mobile number *", FieldKind::Phone, at(920, 380, 400, 40)),
            seen("Work status: I'm a fresher", FieldKind::Radio, at(500, 460, 200, 60)),
            seen("Search your college", FieldKind::PlainText, at(500, 540, 400, 40)),
            seen("Send me job alerts on WhatsApp", FieldKind::Checkbox, at(500, 620, 300, 24)),
            seen("Your email", FieldKind::Email, at(500, 1500, 300, 40)),
            seen("Type a message", FieldKind::MultiLine, at(1550, 800, 320, 80)),
        ];
        let regions = vec![
            region(Part::Banner, "", at(0, 0, 1920, 80)),
            region(Part::Search, "", at(580, 10, 340, 56)),
            region(Part::Form, "", at(1290, 10, 400, 56)),
            region(Part::Region, "Cookie banner", at(1400, 850, 500, 200)),
            region(Part::Footer, "", at(0, 1400, 1920, 300)),
            region(Part::Form, "", at(480, 1480, 360, 80)),
            region(Part::Frame, "Chat with us", at(1530, 500, 360, 420)),
        ];
        (boxes, regions)
    }

    #[test]
    fn with_no_cursor_the_sign_up_form_is_picked_and_the_rest_left_out() {
        let (boxes, regions) = signup();
        let kept = pick(&boxes, &regions, None);
        assert_eq!(
            labels(&boxes, &kept),
            ["Full name *", "Email ID *", "Password *", "Mobile number *", "Work status: I'm a fresher", "Search your college", "Send me job alerts on WhatsApp"],
            "no <form> around it: the boxes near one another, with a search box that sits among them"
        );
    }

    #[test]
    fn the_cursor_in_a_header_box_picks_that_box_s_form_only() {
        let (boxes, regions) = signup();
        assert_eq!(labels(&boxes, &pick(&boxes, &regions, Some(boxes[0].field.bounds))), ["Search jobs"]);
        assert_eq!(labels(&boxes, &pick(&boxes, &regions, Some(boxes[1].field.bounds))), ["Email", "Password"], "the header's login");
        assert_eq!(labels(&boxes, &pick(&boxes, &regions, Some(boxes[11].field.bounds))), ["Your email"], "the newsletter");
        assert_eq!(labels(&boxes, &pick(&boxes, &regions, Some(boxes[12].field.bounds))), ["Type a message"], "the chat");
    }

    #[test]
    fn the_cursor_in_the_form_picks_the_form() {
        let (boxes, regions) = signup();
        let kept = pick(&boxes, &regions, Some(boxes[7].field.bounds));
        assert_eq!(kept, [4, 5, 6, 7, 8, 9, 10]);
    }

    #[test]
    fn a_form_element_is_taken_whole_with_or_without_the_cursor() {
        let (mut boxes, mut regions) = signup();
        regions.push(region(Part::Form, "", at(480, 280, 860, 380)));
        let kept = pick(&boxes, &regions, None);
        assert_eq!(kept, [4, 5, 6, 7, 8, 9, 10]);
        // The cursor on a choice card's label, not a box, is still in the form.
        assert_eq!(pick(&boxes, &regions, Some(at(720, 460, 200, 60))), kept);
        // A box far from the others but in the same <form> still belongs to it.
        boxes.push(seen("Referral code", FieldKind::PlainText, at(500, 650, 200, 8)));
        assert!(pick(&boxes, &regions, None).contains(&13));
    }

    #[test]
    fn a_form_that_wraps_the_whole_page_is_no_guide() {
        let (boxes, mut regions) = signup();
        regions.push(region(Part::Form, "", at(0, 0, 1920, 1700)));
        assert_eq!(pick(&boxes, &regions, None), [4, 5, 6, 7, 8, 9, 10], "an ASP.NET page");
    }

    #[test]
    fn an_open_dialog_with_boxes_is_in_front() {
        let (mut boxes, mut regions) = signup();
        regions.push(region(Part::Dialog, "Create your account", at(700, 200, 500, 400)));
        boxes.push(seen("Name", FieldKind::PlainText, at(750, 260, 400, 40)));
        boxes.push(seen("Phone", FieldKind::Phone, at(750, 330, 400, 40)));
        assert_eq!(labels(&boxes, &pick(&boxes, &regions, None)), ["Name", "Phone"]);
    }

    #[test]
    fn a_cookie_dialog_is_never_the_form() {
        let (boxes, mut regions) = signup();
        regions.push(region(Part::Dialog, "Cookie preferences", at(1400, 850, 500, 200)));
        assert_eq!(pick(&boxes, &regions, None), [4, 5, 6, 7, 8, 9, 10]);
    }

    #[test]
    fn with_two_groups_the_bigger_one_wins() {
        let boxes = vec![
            seen("Email", FieldKind::Email, at(100, 300, 300, 40)),
            seen("Password", FieldKind::Password, at(100, 360, 300, 40)),
            seen("Name", FieldKind::PlainText, at(1000, 300, 300, 40)),
            seen("Email", FieldKind::Email, at(1000, 360, 300, 40)),
            seen("Phone", FieldKind::Phone, at(1000, 420, 300, 40)),
        ];
        assert_eq!(pick(&boxes, &[], None), [2, 3, 4], "log in on the left, sign up on the right");
    }

    #[test]
    fn a_page_with_only_noise_offers_nothing_without_the_cursor() {
        let mut search = seen("Search", FieldKind::PlainText, at(100, 20, 300, 36));
        search.searchbox = true;
        let boxes = vec![search, seen("Subscribe to our newsletter", FieldKind::Email, at(100, 900, 300, 40))];
        assert!(pick(&boxes, &[], None).is_empty());
    }

    #[test]
    fn a_header_login_alone_is_still_a_form() {
        let boxes = vec![seen("Email", FieldKind::Email, at(1300, 20, 160, 36)), seen("Password", FieldKind::Password, at(1470, 20, 160, 36))];
        let regions = vec![region(Part::Banner, "", at(0, 0, 1920, 80))];
        assert_eq!(pick(&boxes, &regions, None), [0, 1]);
    }

    #[test]
    fn nearness_scales_with_the_page_s_box_height() {
        // At 200% zoom everything doubles, and the form stays one group.
        let boxes: Vec<Seen> = (0..4).map(|i| seen("Box", FieldKind::PlainText, at(200, 400 + i * 180, 800, 80))).collect();
        assert_eq!(pick(&boxes, &[], None), [0, 1, 2, 3]);
    }

    #[test]
    fn web_roles_name_the_parts_of_a_page() {
        assert_eq!(Part::from_role("form"), Some(Part::Form));
        assert_eq!(Part::from_role("contentinfo"), Some(Part::Footer));
        assert_eq!(Part::from_role("alertdialog"), Some(Part::Dialog));
        assert_eq!(Part::from_role("group"), None);
    }
}
