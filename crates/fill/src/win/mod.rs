//! The Windows reader and writer: UI Automation to read and set boxes, the
//! clipboard and SendInput for the paste and typing rungs. No screenshots, no
//! hooks, nothing injected into other processes.
//!
//! Make [`Uia`] on the thread that will use it: it holds COM objects, so it cannot
//! move between threads. A call can wait up to a few seconds on a slow app, so keep
//! that thread off the UI.

mod input;

use std::time::{Duration, Instant};

use windows::core::{Interface, BOOL, BSTR};
use windows::Win32::Foundation::{HWND, RECT, RPC_E_CHANGED_MODE};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowLongW, ES_MULTILINE, GWL_STYLE};

use crate::model::{kind_of, label_of, list_hint, marked_required, says, site_from_address, tick_bounds, Bounds, Control, Field, FieldKind, Props, Target};
use crate::policy::{code_cells, is_browser, mark_code, mark_codes};
use crate::finish::Commit;
use crate::scope::{holds, pick, Part, Region, Seen};
use crate::write::{same, Need, Writer};
use crate::{FillError, Reader};

/// The most text a read back takes, so a huge document cannot stall a check.
const MAX_READ: i32 = 200_000;
/// How long a tick box is given to show a turn: 30 waits of 10 ms.
const TURN_WAITS: u32 = 30;
const TURN_WAIT_MS: u64 = 10;
/// How long a browser is given to show the box with the cursor the first time it is asked: 4 tries, 150 ms apart.
const FOCUS_RETRIES: u32 = 4;
const FOCUS_RETRY_MS: u64 = 150;

impl From<windows::core::Error> for FillError {
    fn from(error: windows::core::Error) -> Self {
        if error.code().0 as u32 == UIA_E_ELEMENTNOTAVAILABLE {
            FillError::Gone
        } else {
            FillError::Platform(error.message())
        }
    }
}

/// Closes COM after every COM object is released, so it must stay the last field.
struct Com(bool);

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

pub struct Uia {
    automation: IUIAutomation,
    /// The window [`Reader::target`] read. Everything after works only while it stays in front.
    window: Option<HWND>,
    browser: bool,
    /// The boxes of the last read, by id, with whether each is a cell of a split code, which a read
    /// of the box alone cannot tell.
    boxes: Vec<(IUIAutomationElement, FieldKind, bool)>,
    focused: Option<IUIAutomationElement>,
    _com: Com,
}

fn text(read: windows::core::Result<BSTR>) -> String {
    read.map(|value| value.to_string()).unwrap_or_default()
}

fn flag(read: windows::core::Result<BOOL>) -> bool {
    read.is_ok_and(|value| value.as_bool())
}

fn bounds(rect: RECT) -> Bounds {
    Bounds { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }
}

/// UI Automation's control types, as the pure rules in `model` name them.
#[allow(non_upper_case_globals)]
fn control(id: UIA_CONTROLTYPE_ID) -> Control {
    match id {
        UIA_EditControlTypeId => Control::Edit,
        UIA_DocumentControlTypeId => Control::Document,
        UIA_GroupControlTypeId | UIA_PaneControlTypeId | UIA_CustomControlTypeId => Control::Group,
        UIA_ComboBoxControlTypeId => Control::ComboBox,
        UIA_ListControlTypeId => Control::List,
        UIA_CheckBoxControlTypeId => Control::CheckBox,
        UIA_RadioButtonControlTypeId => Control::RadioButton,
        UIA_SpinnerControlTypeId => Control::Spinner,
        UIA_ButtonControlTypeId | UIA_SplitButtonControlTypeId => Control::Button,
        UIA_HyperlinkControlTypeId => Control::Hyperlink,
        UIA_TabItemControlTypeId => Control::TabItem,
        UIA_MenuItemControlTypeId => Control::MenuItem,
        UIA_ListItemControlTypeId => Control::ListItem,
        UIA_TreeItemControlTypeId => Control::TreeItem,
        _ => Control::Other,
    }
}

/// The page's roles for the parts that tell which form a box belongs to, as `scope::Part` reads them.
const PARTS: &[&str] = &["form", "dialog", "alertdialog", "search", "banner", "navigation", "contentinfo", "complementary", "region", "document"];

/// The longest text before a box that still reads as its label. Longer is a paragraph.
const MAX_LABEL: usize = 200;

impl Uia {
    pub fn new() -> Result<Self, FillError> {
        let started = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if started.is_err() && started != RPC_E_CHANGED_MODE {
            return Err(FillError::Platform(started.message()));
        }
        // A single-threaded COM set up earlier on this thread works too, and is not ours to close.
        let com = Com(started.is_ok());
        let automation: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }?;
        // A hung app fails in seconds instead of the default twenty.
        if let Ok(timeouts) = automation.cast::<IUIAutomation2>() {
            unsafe {
                let _ = timeouts.SetConnectionTimeout(2_000);
                let _ = timeouts.SetTransactionTimeout(5_000);
            }
        }
        Ok(Self { automation, window: None, browser: false, boxes: Vec::new(), focused: None, _com: com })
    }

    fn window(&self) -> Result<HWND, FillError> {
        let hwnd = self.window.ok_or(FillError::NoWindow)?;
        if unsafe { GetForegroundWindow() } != hwnd {
            return Err(FillError::WindowChanged);
        }
        Ok(hwnd)
    }

    /// Waits for the user to let go of their keys, which can take a moment, and only
    /// then checks the box still has the cursor, right before keys go out.
    fn keys_ready(&mut self, id: u32) -> Result<(), FillError> {
        input::keys_up()?;
        self.check(id, Need::Focus)
    }

    fn entry(&self, id: u32) -> Result<(IUIAutomationElement, FieldKind), FillError> {
        self.boxes.get(id as usize).map(|(element, kind, _)| (element.clone(), *kind)).ok_or(FillError::Gone)
    }

    fn equals(&self, property: UIA_PROPERTY_ID, value: VARIANT) -> Result<IUIAutomationCondition, FillError> {
        Ok(unsafe { self.automation.CreatePropertyCondition(property, &value) }?)
    }

    fn control_is(&self, controls: &[UIA_CONTROLTYPE_ID]) -> Result<IUIAutomationCondition, FillError> {
        let mut any = self.equals(UIA_ControlTypePropertyId, controls[0].0.into())?;
        for control in &controls[1..] {
            let next = self.equals(UIA_ControlTypePropertyId, control.0.into())?;
            any = unsafe { self.automation.CreateOrCondition(&any, &next) }?;
        }
        Ok(any)
    }

    /// One round trip brings back every property a box needs, instead of one per property.
    /// Without `values`, what the box holds is left unread.
    fn cache(&self, values: bool) -> Result<IUIAutomationCacheRequest, FillError> {
        let cache = unsafe { self.automation.CreateCacheRequest() }?;
        if values {
            unsafe { cache.AddProperty(UIA_ValueValuePropertyId) }?;
        }
        for property in [
            UIA_NamePropertyId,
            UIA_ControlTypePropertyId,
            UIA_AriaRolePropertyId,
            UIA_FullDescriptionPropertyId,
            UIA_LocalizedControlTypePropertyId,
            UIA_BoundingRectanglePropertyId,
            UIA_IsOffscreenPropertyId,
            UIA_IsPasswordPropertyId,
            UIA_IsRequiredForFormPropertyId,
            UIA_HelpTextPropertyId,
            UIA_AutomationIdPropertyId,
            UIA_ClassNamePropertyId,
            UIA_AriaPropertiesPropertyId,
            UIA_NativeWindowHandlePropertyId,
            UIA_IsTextPatternAvailablePropertyId,
            UIA_IsSelectionPatternAvailablePropertyId,
            UIA_IsKeyboardFocusablePropertyId,
            UIA_ValueIsReadOnlyPropertyId,
            UIA_ToggleToggleStatePropertyId,
            UIA_SelectionItemIsSelectedPropertyId,
        ] {
            unsafe { cache.AddProperty(property) }?;
        }
        for pattern in [UIA_ValuePatternId, UIA_TogglePatternId, UIA_SelectionItemPatternId] {
            unsafe { cache.AddPattern(pattern) }?;
        }
        Ok(cache)
    }

    /// Chrome, Edge and Firefox name their address bar the same way in every language.
    fn address(&self, hwnd: HWND) -> Option<String> {
        let root = unsafe { self.automation.ElementFromHandle(hwnd) }.ok()?;
        let chromium = self.equals(UIA_ClassNamePropertyId, "OmniboxViewViews".into()).ok()?;
        let firefox = self.equals(UIA_AutomationIdPropertyId, "urlbar-input".into()).ok()?;
        let either = unsafe { self.automation.CreateOrCondition(&chromium, &firefox) }.ok()?;
        let bar = unsafe { root.FindFirst(TreeScope_Descendants, &either) }.ok()?;
        let value: IUIAutomationValuePattern = unsafe { bar.GetCurrentPatternAs(UIA_ValuePatternId) }.ok()?;
        site_from_address(&text(unsafe { value.CurrentValue() }))
    }

    /// Children a screen reader would see: an editor's paragraphs. A textarea's text is held in hidden
    /// parts only, which do not count.
    fn has_children(&self, element: &IUIAutomationElement) -> bool {
        let Ok(all) = (unsafe { self.automation.ControlViewCondition() }) else { return false };
        unsafe { element.FindFirst(TreeScope_Children, &all) }.is_ok()
    }

    fn parent(&self, element: &IUIAutomationElement) -> Option<IUIAutomationElement> {
        let walker = unsafe { self.automation.ControlViewWalker() }.ok()?;
        unsafe { walker.GetParentElement(element) }.ok()
    }

    fn document_around(&self, element: &IUIAutomationElement) -> Option<IUIAutomationElement> {
        let mut current = element.clone();
        for _ in 0..64 {
            if unsafe { current.CurrentControlType() }.ok()? == UIA_DocumentControlTypeId {
                return Some(current);
            }
            current = self.parent(&current)?;
        }
        None
    }

    /// The page in front. Chrome keeps a page for every tab of the window in its tree, so the first one
    /// found can be a tab in the background, with its own boxes: the one in front is on screen and
    /// carries the window's title. Frames inside it are pages too, and smaller.
    fn first_document(&self, root: &IUIAutomationElement) -> Option<IUIAutomationElement> {
        let document = self.control_is(&[UIA_DocumentControlTypeId]).ok()?;
        let all = unsafe { root.FindAll(TreeScope_Descendants, &document) }.ok()?;
        let title = screen::foreground().filter(|front| Some(HWND(front.hwnd as *mut _)) == self.window).map(|front| front.title).unwrap_or_default();
        let mut best: Option<((bool, i64), IUIAutomationElement)> = None;
        for index in 0..unsafe { all.Length() }.unwrap_or(0) {
            let Ok(page) = (unsafe { all.GetElement(index) }) else { continue };
            let at = bounds(unsafe { page.CurrentBoundingRectangle() }.unwrap_or_default());
            if flag(unsafe { page.CurrentIsOffscreen() }) || !at.big_enough() {
                continue;
            }
            let name = text(unsafe { page.CurrentName() });
            let score = (!name.trim().is_empty() && title.starts_with(name.trim()), at.width as i64 * at.height as i64);
            if best.as_ref().is_none_or(|(known, _)| score > *known) {
                best = Some((score, page));
            }
        }
        best.map(|(_, page)| page).or_else(|| unsafe { root.FindFirst(TreeScope_Descendants, &document) }.ok())
    }

    /// A box from its cached properties, or None when it is not a box. The rules are in `model`.
    fn describe(&self, element: &IUIAutomationElement, id: u32, focused: bool) -> Result<Option<Seen>, FillError> {
        unsafe {
            let cached = |property| element.GetCachedPropertyValue(property).ok().and_then(|value| bool::try_from(&value).ok()).unwrap_or(false);
            let class = text(element.CachedClassName());
            let aria = text(element.CachedAriaProperties());
            let value_pattern = element.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).ok();
            let props = Props {
                control: control(element.CachedControlType()?),
                role: text(element.CachedAriaRole()).to_lowercase(),
                multiline: aria.contains("multiline=true") || native_multiline(element, &class),
                aria,
                localized: text(element.CachedLocalizedControlType()).to_lowercase(),
                automation_id: text(element.CachedAutomationId()),
                class,
                password: flag(element.CachedIsPassword()),
                value_pattern: value_pattern.is_some(),
                read_only: value_pattern.as_ref().is_some_and(|pattern| flag(pattern.CachedIsReadOnly())),
                text_pattern: cached(UIA_IsTextPatternAvailablePropertyId),
                selectable: cached(UIA_IsSelectionPatternAvailablePropertyId),
                focusable: cached(UIA_IsKeyboardFocusablePropertyId),
                focused,
                empty: value_pattern.as_ref().is_none_or(|pattern| text(pattern.CachedValue()).trim().is_empty()),
                // Asked only of spin buttons, which are rare outside dates.
                in_date: element.CachedControlType()? == UIA_SpinnerControlTypeId
                    && self.parent(element).is_some_and(|parent| {
                        let local = text(parent.CurrentLocalizedControlType()).to_lowercase();
                        local.contains("date") || local.contains("time")
                    }),
            };
            let Some(kind) = kind_of(&props, || self.has_children(element)) else { return Ok(None) };
            let name = text(element.CachedName());
            // A drop-down the page built from a button shows its choice as its name.
            let button_list = kind == FieldKind::List && props.control == Control::Button;

            let mut value = match kind {
                FieldKind::Checkbox => element
                    .GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                    .and_then(|pattern| pattern.CachedToggleState())
                    .is_ok_and(|state| state == ToggleState_On)
                    .to_string(),
                FieldKind::Radio => element
                    .GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
                    .is_ok_and(|pattern| flag(pattern.CachedIsSelected()))
                    .to_string(),
                FieldKind::Tab | FieldKind::Item
                    if element
                        .GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
                        .is_ok_and(|pattern| flag(pattern.CachedIsSelected())) =>
                {
                    "selected".to_string()
                }
                _ if button_list => name.clone(),
                _ => value_pattern.map(|pattern| text(pattern.CachedValue())).unwrap_or_default(),
            };

            let placeholder = text(element.CachedHelpText());
            // Only boxes look around them for words: a button with no name stays unknown, so Finish
            // this for me never presses it on a guess.
            let a_box = !matches!(kind, FieldKind::Button | FieldKind::Link | FieldKind::Tab | FieldKind::MenuItem | FieldKind::Item);
            let hint = if kind == FieldKind::List { list_hint(&value) } else { None };
            let mut label = label_of(
                if button_list { "" } else { &name },
                &placeholder,
                hint.as_deref(),
                // Asked only when there is no name: it costs a round trip, and in
                // Chrome it turns on the heavier screen reader mode.
                || element.CurrentLabeledBy().map(|label| text(label.CurrentName())).unwrap_or_default(),
                || if a_box { self.nearby(element) } else { String::new() },
            );
            // A drop-down the page built is often named by its label and its choice together: "Team size 1–10".
            if button_list && !label.is_empty() {
                if let Some(rest) = value.strip_prefix(label.as_str()) {
                    value = rest.trim().to_string();
                }
            }
            if button_list && label.is_empty() {
                label = name;
            }
            // A choice's own name is only "Yes" or "30 days": its group holds the question.
            if kind == FieldKind::Radio {
                let group = self.parent(element).map(|group| text(group.CurrentName())).unwrap_or_default();
                if !group.trim().is_empty() {
                    label = format!("{}: {label}", group.trim());
                }
            }
            // An unnamed list is the open popup of a drop-down, or the page's words.
            if props.control == Control::List && label.is_empty() {
                return Ok(None);
            }

            let own = bounds(element.CachedBoundingRectangle().unwrap_or_default());
            let on_screen = !flag(element.CachedIsOffscreen());
            let tiny_tick = on_screen && !own.big_enough() && matches!(kind, FieldKind::Checkbox | FieldKind::Radio) && says(&label);
            let (at, visible) = match tiny_tick {
                true => match tick_bounds(own, self.parent(element).and_then(|parent| parent.CurrentBoundingRectangle().ok()).map(bounds)) {
                    Some(card) => (card, true),
                    None => (own, false),
                },
                false => (own, on_screen && own.big_enough()),
            };
            // The hint under or inside the box: its placeholder, else what aria-describedby says.
            let hint_text = if says(&placeholder) {
                placeholder
            } else {
                let described = element.cast::<IUIAutomationElement6>().map(|element| text(element.CachedFullDescription()));
                described.map(|value| value.chars().take(MAX_LABEL).collect()).unwrap_or_default()
            };
            let field = Field {
                id,
                required: flag(element.CachedIsRequiredForForm()) || marked_required(&label),
                label,
                placeholder: hint_text,
                automation_id: props.automation_id.clone(),
                kind,
                visible,
                value,
                bounds: at,
            };
            Ok(Some(Seen { field: field.finish(), searchbox: props.role == "searchbox" }))
        }
    }

    /// The words just before a box with no name, as a person reads its label: an earlier sibling, else
    /// its group's legend. Unnamed boxes of the same type are passed over, so the parts of a date share
    /// the words before the first. Another box in between ends the search, since those words are its own.
    #[allow(non_upper_case_globals)]
    fn nearby(&self, element: &IUIAutomationElement) -> String {
        let Ok(walker) = (unsafe { self.automation.ControlViewWalker() }) else { return String::new() };
        let own = unsafe { element.CachedControlType() }.unwrap_or_default();
        let label = |name: String| if name.chars().count() <= MAX_LABEL { name.trim().to_string() } else { String::new() };
        let a_box = |kind: UIA_CONTROLTYPE_ID| {
            matches!(
                kind,
                UIA_EditControlTypeId
                    | UIA_ComboBoxControlTypeId
                    | UIA_ListControlTypeId
                    | UIA_CheckBoxControlTypeId
                    | UIA_RadioButtonControlTypeId
                    | UIA_SpinnerControlTypeId
                    | UIA_ButtonControlTypeId
                    | UIA_HyperlinkControlTypeId
            )
        };
        let mut node = element.clone();
        // ponytail: two levels and six siblings each, so a page cannot make this walk long. Widen if
        // real labels sit further away.
        for _ in 0..2 {
            let mut passed = 0;
            let mut at = unsafe { walker.GetPreviousSiblingElement(&node) }.ok();
            for _ in 0..6 {
                let Some(sibling) = at else { break };
                let kind = unsafe { sibling.CurrentControlType() }.unwrap_or_default();
                let name = text(unsafe { sibling.CurrentName() });
                match kind {
                    UIA_TextControlTypeId | UIA_GroupControlTypeId | UIA_CustomControlTypeId if says(&name) => return label(name),
                    // A paragraph has no name of its own: its words are its last child.
                    UIA_GroupControlTypeId | UIA_CustomControlTypeId => {
                        if let Ok(last) = unsafe { walker.GetLastChildElement(&sibling) } {
                            let inner = unsafe { last.CurrentControlType() }.unwrap_or_default();
                            let words = text(unsafe { last.CurrentName() });
                            if inner == UIA_TextControlTypeId && says(&words) {
                                return label(words);
                            }
                            if a_box(inner) {
                                return String::new();
                            }
                        }
                    }
                    _ if kind == own && !says(&name) && passed < 2 => passed += 1,
                    _ if a_box(kind) => return String::new(),
                    _ => {}
                }
                at = unsafe { walker.GetPreviousSiblingElement(&sibling) }.ok();
            }
            let Ok(parent) = (unsafe { walker.GetParentElement(&node) }) else { break };
            if unsafe { parent.CurrentControlType() }.is_ok_and(|kind| kind == UIA_DocumentControlTypeId) {
                break;
            }
            // A fieldset's legend names its boxes; a form's or a section's name does not name one box.
            let role = text(unsafe { parent.CurrentAriaRole() });
            let name = text(unsafe { parent.CurrentName() });
            if matches!(role.as_str(), "group" | "radiogroup" | "") && says(&name) {
                return label(name);
            }
            node = parent;
        }
        String::new()
    }

    /// Where the keyboard cursor is on the page, box or not. None when it is on the page itself, or
    /// outside it, as in the address bar.
    fn focus_in(&self, page: &IUIAutomationElement) -> Option<Bounds> {
        let cache = unsafe { self.automation.CreateCacheRequest() }.ok()?;
        unsafe { cache.AddProperty(UIA_BoundingRectanglePropertyId) }.ok()?;
        let focused = unsafe { self.automation.GetFocusedElementBuildCache(&cache) }.ok()?;
        let at = bounds(unsafe { focused.CachedBoundingRectangle() }.ok()?);
        let page = bounds(unsafe { page.CurrentBoundingRectangle() }.ok()?);
        (at != page && at.width > 0 && at.height > 0 && holds(&page, &at)).then_some(at)
    }

    /// Whether the box with the cursor is a cell of a split code, from the boxes around it.
    fn in_code(&self, element: &IUIAutomationElement, at: Bounds) -> bool {
        if !(at.big_enough() && at.width <= at.height * 2) {
            return false;
        }
        let Ok(edits) = self.control_is(&[UIA_EditControlTypeId, UIA_SpinnerControlTypeId]) else { return false };
        let Ok(cache) = (unsafe { self.automation.CreateCacheRequest() }) else { return false };
        if unsafe { cache.AddProperty(UIA_BoundingRectanglePropertyId) }.is_err() {
            return false;
        }
        let mut node = element.clone();
        // The cells are each in their own wrapper, so look up to three parents out for four or more.
        for _ in 0..3 {
            let Some(parent) = self.parent(&node) else { return false };
            let Ok(found) = (unsafe { parent.FindAllBuildCache(TreeScope_Descendants, &edits, &cache) }) else { return false };
            let read: Vec<(FieldKind, Bounds)> = (0..unsafe { found.Length() }.unwrap_or(0))
                .filter_map(|index| unsafe { found.GetElement(index) }.ok())
                .map(|edit| (FieldKind::PlainText, bounds(unsafe { edit.CachedBoundingRectangle() }.unwrap_or_default())))
                .collect();
            if read.len() >= 4 {
                return code_cells(&read).iter().any(|&cell| read[cell].1 == at);
            }
            node = parent;
        }
        false
    }

    fn item(&self, list: &IUIAutomationElement, wanted: &str) -> Result<Option<IUIAutomationElement>, FillError> {
        let items = self.control_is(&[UIA_ListItemControlTypeId])?;
        let cache = unsafe { self.automation.CreateCacheRequest() }?;
        unsafe { cache.AddProperty(UIA_NamePropertyId) }?;
        let found = unsafe { list.FindAllBuildCache(TreeScope_Descendants, &items, &cache) }?;
        for index in 0..unsafe { found.Length() }? {
            let item = unsafe { found.GetElement(index) }?;
            if same(&text(unsafe { item.CachedName() }).to_lowercase(), &wanted.to_lowercase()) {
                return Ok(Some(item));
            }
        }
        Ok(None)
    }

    /// The choice in the list a drop-down controls (aria-controls, or the popup it has open).
    fn popup_item(&self, list: &IUIAutomationElement, wanted: &str) -> Option<IUIAutomationElement> {
        let popups = unsafe { list.CurrentControllerFor() }.ok()?;
        (0..unsafe { popups.Length() }.ok()?).find_map(|index| {
            let popup = unsafe { popups.GetElement(index) }.ok()?;
            self.item(&popup, wanted).ok().flatten()
        })
    }

    /// The names of the window's text, when it offers no text pattern.
    fn names(&self, root: &IUIAutomationElement, limit: usize) -> Result<String, FillError> {
        let texts = self.control_is(&[UIA_TextControlTypeId])?;
        let cache = unsafe { self.automation.CreateCacheRequest() }?;
        unsafe { cache.AddProperty(UIA_NamePropertyId) }?;
        let found = unsafe { root.FindAllBuildCache(TreeScope_Descendants, &texts, &cache) }?;
        let mut out = String::new();
        for index in 0..unsafe { found.Length() }? {
            let name = text(unsafe { found.GetElement(index)?.CachedName() });
            if out.chars().count() + name.chars().count() > limit {
                break;
            }
            out.push_str(name.trim());
            out.push('\n');
        }
        Ok(out)
    }

    /// The last `limit` characters before the focused box, or of the whole document.
    fn text_before(&self, pattern: &IUIAutomationTextPattern, limit: i32) -> Result<String, FillError> {
        unsafe {
            let range = pattern.DocumentRange()?;
            if let Some(own) = self.focused.as_ref().and_then(|element| pattern.RangeFromChild(element).ok()) {
                let _ = range.MoveEndpointByRange(TextPatternRangeEndpoint_End, &own, TextPatternRangeEndpoint_Start);
            }
            let tail = range.Clone()?;
            tail.MoveEndpointByRange(TextPatternRangeEndpoint_Start, &range, TextPatternRangeEndpoint_End)?;
            tail.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -limit)?;
            Ok(tail.GetText(limit)?.to_string())
        }
    }
}

/// A classic Windows edit box says it takes many lines in its window style.
fn native_multiline(element: &IUIAutomationElement, class: &str) -> bool {
    if !class.to_lowercase().contains("edit") {
        return false;
    }
    let Ok(hwnd) = (unsafe { element.CachedNativeWindowHandle() }) else { return false };
    !hwnd.is_invalid() && unsafe { GetWindowLongW(hwnd, GWL_STYLE) } & ES_MULTILINE != 0
}

impl Reader for Uia {
    fn target(&mut self) -> Result<Target, FillError> {
        self.window = None;
        self.boxes.clear();
        self.focused = None;
        let front = screen::foreground().ok_or(FillError::NoWindow)?;
        let hwnd = HWND(front.hwnd as *mut _);
        // ponytail: Store apps report as ApplicationFrameHost.exe. Read the hosted
        // app's process if the list of apps needs to tell them apart.
        self.browser = is_browser(&front.process);
        let site = if self.browser { self.address(hwnd) } else { None };
        self.window = Some(hwnd);
        Ok(Target { process: front.process, title: front.title, site })
    }

    fn focused(&mut self) -> Result<Field, FillError> {
        self.focused_with(true)
    }

    fn fields(&mut self) -> Result<Vec<Field>, FillError> {
        let hwnd = self.window()?;
        self.boxes.clear();
        self.focused = None;
        let root = unsafe { self.automation.ElementFromHandle(hwnd) }?;
        // In a browser only the page counts: the address bar and toolbar are not the form.
        let scope = if self.browser {
            match self.first_document(&root) {
                Some(page) => page,
                None => return Ok(Vec::new()),
            }
        } else {
            root
        };
        let controls = self.control_is(&[
            UIA_EditControlTypeId,
            UIA_ComboBoxControlTypeId,
            UIA_ListControlTypeId,
            UIA_CheckBoxControlTypeId,
            UIA_RadioButtonControlTypeId,
            UIA_SpinnerControlTypeId,
            UIA_ButtonControlTypeId,
        ])?;
        let enabled = self.equals(UIA_IsEnabledPropertyId, true.into())?;
        let on_screen = self.equals(UIA_IsOffscreenPropertyId, false.into())?;
        let shown = unsafe { self.automation.CreateAndCondition(&enabled, &on_screen) }?;
        let wanted = unsafe { self.automation.CreateAndCondition(&controls, &shown) }?;
        // The page's forms, dialogs, frames, header and footer come in the same walk of the page, so
        // telling which boxes are the form costs no second one.
        let mut parts = self.control_is(&[UIA_DocumentControlTypeId])?;
        for role in PARTS {
            let next = self.equals(UIA_AriaRolePropertyId, (*role).into())?;
            parts = unsafe { self.automation.CreateOrCondition(&parts, &next) }?;
        }
        let either = unsafe { self.automation.CreateOrCondition(&wanted, &parts) }?;
        let found = unsafe { scope.FindAllBuildCache(TreeScope_Descendants, &either, &self.cache(true)?) }?;

        let mut seen = Vec::new();
        let mut elements = Vec::new();
        let mut regions = Vec::new();
        for index in 0..unsafe { found.Length() }? {
            let Ok(element) = (unsafe { found.GetElement(index) }) else { continue };
            // Only containers are parts: a box the page calls a "document" is still a box.
            let part = match control(unsafe { element.CachedControlType() }.unwrap_or_default()) {
                Control::Document => Some(Part::Frame),
                Control::Group | Control::Other => Part::from_role(&text(unsafe { element.CachedAriaRole() }).to_lowercase()),
                _ => None,
            };
            if let Some(part) = part {
                let at = bounds(unsafe { element.CachedBoundingRectangle() }.unwrap_or_default());
                regions.push(Region { part, name: text(unsafe { element.CachedName() }), bounds: at });
                continue;
            }
            let Ok(Some(box_seen)) = self.describe(&element, 0, false) else { continue };
            // Plain buttons are not boxes. A file input shows as a button and stays, as yours to fill.
            if !box_seen.field.visible || box_seen.field.kind == FieldKind::Button {
                // A Submit, Send or Sign up button ends its form, so the boxes after it are another one.
                let ends_a_form = matches!(
                    crate::finish::commit(&box_seen.field.words()),
                    Some(Commit::Submit | Commit::Send | Commit::Account | Commit::Pay | Commit::Book | Commit::Confirm)
                );
                if box_seen.field.visible && box_seen.field.kind == FieldKind::Button && ends_a_form {
                    regions.push(Region { part: Part::Submit, name: box_seen.field.label.clone(), bounds: box_seen.field.bounds });
                }
                continue;
            }
            elements.push(element);
            seen.push(box_seen);
        }

        // A desktop app's window is its form. With no web parts to go by, nearness alone could split a dialog.
        let keep = if self.browser || !regions.is_empty() { pick(&seen, &regions, self.focus_in(&scope)) } else { (0..seen.len()).collect() };
        let mut fields: Vec<Field> = keep.iter().map(|&at| seen[at].field.clone()).collect();
        let cells = mark_codes(&mut fields);
        for (id, (field, &at)) in fields.iter_mut().zip(&keep).enumerate() {
            field.id = id as u32;
            self.boxes.push((elements[at].clone(), field.kind, cells.contains(&id)));
        }
        Ok(fields)
    }

    fn text(&mut self, limit: usize) -> Result<String, FillError> {
        let hwnd = self.window()?;
        let root = unsafe { self.automation.ElementFromHandle(hwnd) }?;
        let document =
            self.focused.as_ref().and_then(|element| self.document_around(element)).or_else(|| self.first_document(&root));
        if let Some(pattern) =
            document.and_then(|document| unsafe { document.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }.ok())
        {
            return self.text_before(&pattern, limit.min(MAX_READ as usize) as i32);
        }
        self.names(&root, limit)
    }
}

impl Uia {
    /// The box with the cursor, read without what it holds: enough to tell whether Write here
    /// could start there, as the island's button needs to know.
    pub fn peek_focused(&mut self) -> Result<Field, FillError> {
        self.focused_with(false)
    }

    /// Where a box of the last read is now, in screen pixels, for the outlines drawn over it. None
    /// once it has scrolled off, gone, or its window is no longer in front.
    pub fn place(&mut self, id: u32) -> Option<Bounds> {
        self.window().ok()?;
        let (element, kind) = self.entry(id).ok()?;
        if flag(unsafe { element.CurrentIsOffscreen() }) {
            return None;
        }
        let own = bounds(unsafe { element.CurrentBoundingRectangle() }.ok()?);
        if own.big_enough() || !matches!(kind, FieldKind::Checkbox | FieldKind::Radio) {
            return own.big_enough().then_some(own);
        }
        // A styled tick is a one-pixel input inside the card you see.
        tick_bounds(own, self.parent(&element).and_then(|parent| unsafe { parent.CurrentBoundingRectangle() }.ok()).map(bounds))
    }

    fn focused_with(&mut self, values: bool) -> Result<Field, FillError> {
        self.window()?;
        self.boxes.clear();
        self.focused = None;
        let cache = self.cache(values)?;
        let element = unsafe { self.automation.GetFocusedElementBuildCache(&cache) }.map_err(|_| FillError::NoBox)?;
        // The focus lives in the window in front, so it is still ours if that has not changed.
        self.window()?;
        // In a browser only the page counts: the address bar and the browser's own boxes are not the user's to have written in.
        // A browser asked for the first time shows the focus on its own frame, and the box a moment later, once it has
        // built the page's tree for us: so it is asked again, briefly, before the answer is no.
        let mut element = element;
        let mut tries = 0;
        while self.browser && self.document_around(&element).is_none() {
            tries += 1;
            if tries > FOCUS_RETRIES {
                return Err(FillError::NoBox);
            }
            std::thread::sleep(Duration::from_millis(FOCUS_RETRY_MS));
            element = unsafe { self.automation.GetFocusedElementBuildCache(&cache) }.map_err(|_| FillError::NoBox)?;
            self.window()?;
        }
        let mut field = self.describe(&element, 0, true)?.ok_or(FillError::NoBox)?.field;
        if matches!(
            field.kind,
            FieldKind::Button | FieldKind::File | FieldKind::List | FieldKind::Checkbox | FieldKind::Radio | FieldKind::Link | FieldKind::Tab | FieldKind::MenuItem | FieldKind::Item
        ) {
            return Err(FillError::NoBox);
        }
        // One cell of a split code has no label to say so; its neighbours do, by their shape.
        let code = matches!(field.kind, FieldKind::PlainText | FieldKind::Number | FieldKind::Phone) && self.in_code(&element, field.bounds);
        if code {
            mark_code(&mut field);
        }
        self.boxes.push((element.clone(), field.kind, code));
        self.focused = Some(element);
        Ok(field)
    }
}

/// Finish this for me's eyes and hands. Everything works only in the window [`Reader::target`] read,
/// and only while it is in front. Nothing moves the mouse or sends a key: pressing goes through UI
/// Automation's own patterns, and writing through the writer ladder.
impl Uia {
    /// Every control you can see in the window: boxes, buttons, links, tabs, menu items and rows, in
    /// page order. Unlike [`Reader::fields`], ids carry on from the reads before, so an id read
    /// earlier still names the same control, or fails with Gone once it has left the page.
    pub fn elements(&mut self) -> Result<Vec<Field>, FillError> {
        let hwnd = self.window()?;
        let root = unsafe { self.automation.ElementFromHandle(hwnd) }?;
        // In a browser only the page counts: the address bar is not the task's to use.
        let scope = if self.browser {
            match self.first_document(&root) {
                Some(page) => page,
                None => return Ok(Vec::new()),
            }
        } else {
            root
        };
        let controls = self.control_is(&[
            UIA_EditControlTypeId,
            UIA_ComboBoxControlTypeId,
            UIA_ListControlTypeId,
            UIA_CheckBoxControlTypeId,
            UIA_RadioButtonControlTypeId,
            UIA_SpinnerControlTypeId,
            UIA_ButtonControlTypeId,
            UIA_SplitButtonControlTypeId,
            UIA_HyperlinkControlTypeId,
            UIA_TabItemControlTypeId,
            UIA_MenuItemControlTypeId,
            UIA_ListItemControlTypeId,
            UIA_TreeItemControlTypeId,
        ])?;
        let enabled = self.equals(UIA_IsEnabledPropertyId, true.into())?;
        let on_screen = self.equals(UIA_IsOffscreenPropertyId, false.into())?;
        let shown = unsafe { self.automation.CreateAndCondition(&enabled, &on_screen) }?;
        let wanted = unsafe { self.automation.CreateAndCondition(&controls, &shown) }?;
        let found = unsafe { scope.FindAllBuildCache(TreeScope_Descendants, &wanted, &self.cache(true)?) }?;
        let mut elements = Vec::new();
        for index in 0..unsafe { found.Length() }? {
            let Ok(element) = (unsafe { found.GetElement(index) }) else { continue };
            // The same control read again keeps the id it had.
            // ponytail: one comparison per control already known, so a read costs n × known. Fine for a
            // form of a few hundred controls; cache runtime ids and compare them here if a big page drags.
            let known = self.boxes.iter().position(|(seen, _, _)| unsafe { self.automation.CompareElements(seen, &element) }.is_ok_and(|same| same.as_bool()));
            let id = known.unwrap_or(self.boxes.len()) as u32;
            let Ok(Some(Seen { field, .. })) = self.describe(&element, id, false) else { continue };
            if !field.visible {
                continue;
            }
            if known.is_none() {
                self.boxes.push((element, field.kind, false));
            }
            elements.push(field);
        }
        // A split code's cells are refused here too, and stay refused when one is read again alone.
        for cell in mark_codes(&mut elements) {
            self.boxes[elements[cell].id as usize].2 = true;
        }
        Ok(elements)
    }

    /// One control read again, as it is right now, under the id it already has. A page can rename or
    /// swap a control after it was read, so this is what a step is checked against just before it acts.
    pub fn fresh(&mut self, id: u32) -> Result<Field, FillError> {
        self.window()?;
        let (element, _) = self.entry(id)?;
        let now = unsafe { element.BuildUpdatedCache(&self.cache(true)?) }?;
        let mut field = self.describe(&now, id, false)?.ok_or(FillError::Gone)?.field;
        if self.boxes[id as usize].2 {
            mark_code(&mut field);
        }
        self.boxes[id as usize].1 = field.kind;
        Ok(field)
    }

    /// The window as it is now, without reading it again: its site may have changed.
    pub fn now(&self) -> Result<Target, FillError> {
        let hwnd = self.window()?;
        let front = screen::foreground().ok_or(FillError::NoWindow)?;
        let site = if self.browser { self.address(hwnd) } else { None };
        Ok(Target { process: front.process, title: front.title, site })
    }

    /// Where a control is on the screen now, for the blue cursor.
    pub fn bounds(&self, id: u32) -> Result<Bounds, FillError> {
        self.window()?;
        let (element, _) = self.entry(id)?;
        Ok(bounds(unsafe { element.CurrentBoundingRectangle() }?))
    }

    /// Presses a button or link, picks a tab, row or choice, or opens a list, the way a screen reader
    /// does. A control that offers none of these is left for the user, rather than clicked with the mouse.
    pub fn press(&mut self, id: u32) -> Result<(), FillError> {
        self.window()?;
        let (element, _) = self.entry(id)?;
        unsafe {
            if let Ok(invoke) = element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                return Ok(invoke.Invoke()?);
            }
            if let Ok(item) = element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
                return Ok(item.Select()?);
            }
            if let Ok(toggle) = element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
                return Ok(toggle.Toggle()?);
            }
            if let Ok(expand) = element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
                if expand.CurrentExpandCollapseState()? == ExpandCollapseState_Collapsed {
                    expand.Expand()?;
                } else {
                    expand.Collapse()?;
                }
                return Ok(());
            }
        }
        Err(FillError::NeedsYou("It cannot be pressed without the mouse, so it is yours to press.".into()))
    }

    /// Scrolls the page, or the window, a screen up or down.
    pub fn scroll(&mut self, down: bool) -> Result<(), FillError> {
        let hwnd = self.window()?;
        let root = unsafe { self.automation.ElementFromHandle(hwnd) }?;
        let page = if self.browser { self.first_document(&root).unwrap_or(root.clone()) } else { root.clone() };
        let scrolls = self.equals(UIA_IsScrollPatternAvailablePropertyId, true.into())?;
        let target = unsafe { page.FindFirst(TreeScope_Subtree, &scrolls) }.or_else(|_| unsafe { root.FindFirst(TreeScope_Subtree, &scrolls) })?;
        let pattern: IUIAutomationScrollPattern = unsafe { target.GetCurrentPatternAs(UIA_ScrollPatternId) }?;
        let amount = if down { ScrollAmount_LargeIncrement } else { ScrollAmount_LargeDecrement };
        unsafe { pattern.Scroll(ScrollAmount_NoAmount, amount) }?;
        Ok(())
    }
}

impl Writer for Uia {
    fn check(&mut self, id: u32, need: Need) -> Result<(), FillError> {
        self.window()?;
        let (element, _) = self.entry(id)?;
        // A box that has left the page fails any live read.
        unsafe { element.CurrentBoundingRectangle() }?;
        if need == Need::Focus {
            let mut tries = 0;
            loop {
                let focused = unsafe { self.automation.GetFocusedElement() }.map_err(|_| FillError::Moved)?;
                if unsafe { self.automation.CompareElements(&focused, &element) }?.as_bool() {
                    break;
                }
                // A browser shows the focus on its own frame for a moment after the cursor goes into a box,
                // and only then on the box: asked again, briefly. A cursor in another box of the page is an
                // answer at once.
                tries += 1;
                if !self.browser || self.document_around(&focused).is_some() || tries > FOCUS_RETRIES {
                    return Err(FillError::Moved);
                }
                std::thread::sleep(Duration::from_millis(FOCUS_RETRY_MS));
                self.window()?;
            }
        }
        Ok(())
    }

    fn value(&mut self, id: u32) -> Result<String, FillError> {
        let (element, kind) = self.entry(id)?;
        unsafe {
            match kind {
                FieldKind::Checkbox => {
                    let toggle: IUIAutomationTogglePattern = element.GetCurrentPatternAs(UIA_TogglePatternId)?;
                    Ok((toggle.CurrentToggleState()? == ToggleState_On).to_string())
                }
                FieldKind::Radio => {
                    let item: IUIAutomationSelectionItemPattern = element.GetCurrentPatternAs(UIA_SelectionItemPatternId)?;
                    Ok(item.CurrentIsSelected()?.as_bool().to_string())
                }
                _ => {
                    if let Ok(value) = element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                        return Ok(value.CurrentValue()?.to_string());
                    }
                    if kind == FieldKind::List {
                        let selection: IUIAutomationSelectionPattern = element.GetCurrentPatternAs(UIA_SelectionPatternId)?;
                        let chosen = selection.GetCurrentSelection()?;
                        return Ok(if chosen.Length()? > 0 { text(chosen.GetElement(0)?.CurrentName()) } else { String::new() });
                    }
                    let document: IUIAutomationTextPattern = element.GetCurrentPatternAs(UIA_TextPatternId)?;
                    Ok(document.DocumentRange()?.GetText(MAX_READ)?.to_string())
                }
            }
        }
    }

    fn set_value(&mut self, id: u32, value: &str) -> Result<(), FillError> {
        let (element, _) = self.entry(id)?;
        unsafe {
            let pattern: IUIAutomationValuePattern = element.GetCurrentPatternAs(UIA_ValuePatternId)?;
            if pattern.CurrentIsReadOnly()?.as_bool() {
                return Err(FillError::NeedsYou("This box cannot be changed.".into()));
            }
            // UI Automation moves the focus to the box first, so the page sees a person's focus and blur.
            pattern.SetValue(&BSTR::from(value))?;
        }
        Ok(())
    }

    fn set_checked(&mut self, id: u32, on: bool) -> Result<(), FillError> {
        let (element, kind) = self.entry(id)?;
        unsafe {
            if kind == FieldKind::Radio {
                if !on {
                    return Err(FillError::NeedsYou("A choice is cleared by picking another one.".into()));
                }
                let item: IUIAutomationSelectionItemPattern = element.GetCurrentPatternAs(UIA_SelectionItemPatternId)?;
                item.Select()?;
                return Ok(());
            }
            let toggle: IUIAutomationTogglePattern = element.GetCurrentPatternAs(UIA_TogglePatternId)?;
            // At most two turns: a three-state box may pass through "mixed". A browser shows a turn a
            // moment later, so each one waits to show before the next is decided: read too soon, the
            // box still looks unticked, a second turn goes in, and the tick is taken back out.
            for _ in 0..2 {
                let state = toggle.CurrentToggleState()?;
                if (state == ToggleState_On) == on {
                    return Ok(());
                }
                toggle.Toggle()?;
                for _ in 0..TURN_WAITS {
                    if toggle.CurrentToggleState()? != state {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(TURN_WAIT_MS));
                }
            }
            if (toggle.CurrentToggleState()? == ToggleState_On) == on {
                Ok(())
            } else {
                Err(FillError::Uncertain)
            }
        }
    }

    fn choose(&mut self, id: u32, wanted: &str) -> Result<(), FillError> {
        let (element, _) = self.entry(id)?;
        let mut found = self.item(&element, wanted)?;
        // Some lists build their items only once opened.
        let opened = match found {
            Some(_) => None,
            None => {
                let expand =
                    unsafe { element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) }.ok();
                if let Some(expand) = &expand {
                    unsafe { expand.Expand() }?;
                    std::thread::sleep(Duration::from_millis(150));
                    found = self.item(&element, wanted)?;
                    // A drop-down the page built shows its choices elsewhere on the page, and points at them.
                    if found.is_none() {
                        found = self.popup_item(&element, wanted);
                    }
                }
                expand
            }
        };
        let picked = match found {
            Some(item) => unsafe { item.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) }
                .and_then(|pattern| unsafe { pattern.Select() })
                .map_err(FillError::from),
            None => Err(FillError::NeedsYou("That choice is not in the list.".into())),
        };
        // Picking closes most lists by itself, and closing one that is shut can open it again.
        if let Some(expand) = opened {
            if unsafe { expand.CurrentExpandCollapseState() }.is_ok_and(|state| state == ExpandCollapseState_Expanded) {
                let _ = unsafe { expand.Collapse() };
            }
        }
        picked
    }

    fn focus(&mut self, id: u32) -> Result<(), FillError> {
        let (element, _) = self.entry(id)?;
        unsafe { element.SetFocus() }?;
        Ok(())
    }

    fn paste(&mut self, id: u32, text: &str, replace: bool) -> Result<(), FillError> {
        let before = self.value(id).ok();
        self.keys_ready(id)?;
        let swap = input::swap_in(text)?;
        // From here the user's clipboard goes back on every path.
        let sent = input::paste_keys(replace);
        if sent.is_ok() {
            // The box changing means the app has read the clipboard.
            // ponytail: a box that cannot be read gets a fixed half second, and an
            // app slower than that pastes the old clipboard; the read back catches it.
            let wait = if before.is_some() { 1_500 } else { 500 };
            let deadline = Instant::now() + Duration::from_millis(wait);
            while Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
                if before.is_some() && self.value(id).ok() != before {
                    break;
                }
            }
        }
        let restored = swap.restore();
        sent?;
        restored
    }

    fn type_text(&mut self, id: u32, text: &str, replace: bool) -> Result<(), FillError> {
        self.keys_ready(id)?;
        input::type_text(text, replace)
    }

    fn undo_keys(&mut self, id: u32) -> Result<(), FillError> {
        self.keys_ready(id)?;
        input::undo_keys()
    }

    fn plain(&mut self, id: u32) -> bool {
        self.entry(id).is_ok_and(|(element, _)| !self.has_children(&element))
    }

    /// Found from the end, so the words just written come before an older copy above them. Line
    /// by line, because editors keep line breaks their own way. No key is sent.
    fn select(&mut self, id: u32, text: &str) -> Result<(), FillError> {
        let (element, _) = self.entry(id)?;
        let lines: Vec<&str> = text.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
        let (Some(first), Some(last)) = (lines.first(), lines.last()) else { return Ok(()) };
        unsafe {
            let pattern: IUIAutomationTextPattern = match element.GetCurrentPatternAs(UIA_TextPatternId) {
                Ok(pattern) => pattern,
                Err(_) => self.document_around(&element).ok_or(FillError::NoBox)?.GetCurrentPatternAs(UIA_TextPatternId)?,
            };
            let all = pattern.DocumentRange()?;
            let end = all.FindText(&BSTR::from(*last), true, false)?;
            let span = if lines.len() == 1 {
                end
            } else {
                let above = all.Clone()?;
                above.MoveEndpointByRange(TextPatternRangeEndpoint_End, &end, TextPatternRangeEndpoint_Start)?;
                let start = above.FindText(&BSTR::from(*first), true, false)?;
                start.MoveEndpointByRange(TextPatternRangeEndpoint_End, &end, TextPatternRangeEndpoint_End)?;
                start
            };
            span.Select()?;
        }
        Ok(())
    }
}

/// Puts text on the clipboard as an ordinary copy, when the user asks for one.
pub fn copy(text: &str) -> Result<(), FillError> {
    input::copy(text)
}

/// The text on the clipboard. Read only when the user says "from my clipboard".
pub fn pasted() -> Result<String, FillError> {
    input::pasted()
}
