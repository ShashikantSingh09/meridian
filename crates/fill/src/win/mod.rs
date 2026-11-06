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
use windows::Win32::Foundation::{HWND, RPC_E_CHANGED_MODE};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowLongW, ES_MULTILINE, GWL_STYLE};

use crate::model::{site_from_address, Bounds, Field, FieldKind, Target};
use crate::policy::is_browser;
use crate::write::{same, Need, Writer};
use crate::{FillError, Reader};

/// The most text a read back takes, so a huge document cannot stall a check.
const MAX_READ: i32 = 200_000;

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
    /// The boxes of the last read, by id.
    boxes: Vec<(IUIAutomationElement, FieldKind)>,
    focused: Option<IUIAutomationElement>,
    _com: Com,
}

fn text(read: windows::core::Result<BSTR>) -> String {
    read.map(|value| value.to_string()).unwrap_or_default()
}

fn flag(read: windows::core::Result<BOOL>) -> bool {
    read.is_ok_and(|value| value.as_bool())
}

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
        self.boxes.get(id as usize).cloned().ok_or(FillError::Gone)
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
    fn cache(&self) -> Result<IUIAutomationCacheRequest, FillError> {
        let cache = unsafe { self.automation.CreateCacheRequest() }?;
        for property in [
            UIA_NamePropertyId,
            UIA_ControlTypePropertyId,
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
            UIA_ValueValuePropertyId,
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

    fn has_children(&self, element: &IUIAutomationElement) -> bool {
        let Ok(all) = (unsafe { self.automation.CreateTrueCondition() }) else { return false };
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

    fn first_document(&self, root: &IUIAutomationElement) -> Option<IUIAutomationElement> {
        let document = self.control_is(&[UIA_DocumentControlTypeId]).ok()?;
        unsafe { root.FindFirst(TreeScope_Descendants, &document) }.ok()
    }

    /// A box from its cached properties, or None when it is not a box.
    // The control type constants keep Windows' own names.
    #[allow(non_upper_case_globals)]
    fn describe(&self, element: &IUIAutomationElement, id: u32, focused: bool) -> Result<Option<Field>, FillError> {
        unsafe {
            let control = element.CachedControlType()?;
            let automation_id = text(element.CachedAutomationId());
            let class = text(element.CachedClassName());
            let localized = text(element.CachedLocalizedControlType()).to_lowercase();
            let value_pattern = element.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).ok();
            let read_only = value_pattern.as_ref().is_some_and(|pattern| flag(pattern.CachedIsReadOnly()));
            let multiline = text(element.CachedAriaProperties()).contains("multiline=true") || native_multiline(element, &class);
            let text_pattern = element
                .GetCachedPropertyValue(UIA_IsTextPatternAvailablePropertyId)
                .ok()
                .and_then(|value| bool::try_from(&value).ok())
                .unwrap_or(false);

            let kind = match control {
                UIA_EditControlTypeId if flag(element.CachedIsPassword()) => FieldKind::Password,
                // A contenteditable editor has its paragraphs as children; a textarea has none.
                UIA_EditControlTypeId if class.contains("RichEdit") || (multiline && self.has_children(element)) => {
                    FieldKind::RichText
                }
                UIA_EditControlTypeId if multiline => FieldKind::MultiLine,
                UIA_EditControlTypeId if localized.contains("date") || localized.contains("time") => FieldKind::Date,
                UIA_EditControlTypeId => FieldKind::PlainText,
                // Word's body, or a page's own editable area. A whole web page is not a box.
                UIA_DocumentControlTypeId if focused && automation_id != "RootWebArea" => FieldKind::RichText,
                // A bare contenteditable shows as a group that holds text.
                UIA_GroupControlTypeId | UIA_PaneControlTypeId | UIA_CustomControlTypeId if focused && text_pattern => {
                    FieldKind::RichText
                }
                // A combo box you can type in is a text box with suggestions.
                UIA_ComboBoxControlTypeId if value_pattern.is_some() && !read_only => FieldKind::PlainText,
                UIA_ComboBoxControlTypeId | UIA_ListControlTypeId => FieldKind::List,
                UIA_CheckBoxControlTypeId => FieldKind::Checkbox,
                UIA_RadioButtonControlTypeId => FieldKind::Radio,
                UIA_SpinnerControlTypeId => FieldKind::Number,
                UIA_ButtonControlTypeId | UIA_SplitButtonControlTypeId => FieldKind::Button,
                _ => return Ok(None),
            };
            if read_only && kind != FieldKind::List {
                return Ok(None);
            }

            let value = match kind {
                FieldKind::Checkbox => element
                    .GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                    .and_then(|pattern| pattern.CachedToggleState())
                    .is_ok_and(|state| state == ToggleState_On)
                    .to_string(),
                FieldKind::Radio => element
                    .GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
                    .is_ok_and(|pattern| flag(pattern.CachedIsSelected()))
                    .to_string(),
                _ => value_pattern.map(|pattern| text(pattern.CachedValue())).unwrap_or_default(),
            };

            let name = text(element.CachedName());
            let placeholder = text(element.CachedHelpText());
            let mut label = if !name.trim().is_empty() {
                name
            } else {
                // Asked only when there is no name: it costs a round trip, and in
                // Chrome it turns on the heavier screen reader mode.
                element
                    .CurrentLabeledBy()
                    .map(|label| text(label.CurrentName()))
                    .ok()
                    .filter(|label| !label.trim().is_empty())
                    .unwrap_or_else(|| placeholder.clone())
            };
            // A choice's own name is only "Yes" or "30 days": its group holds the question.
            if kind == FieldKind::Radio {
                let group = self.parent(element).map(|group| text(group.CurrentName())).unwrap_or_default();
                if !group.trim().is_empty() {
                    label = format!("{}: {label}", group.trim());
                }
            }

            let rect = element.CachedBoundingRectangle().unwrap_or_default();
            let bounds = Bounds { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
            let visible = !flag(element.CachedIsOffscreen()) && bounds.big_enough();
            let field = Field {
                id,
                label,
                placeholder,
                automation_id,
                kind,
                required: flag(element.CachedIsRequiredForForm()),
                visible,
                value,
                bounds,
            };
            Ok(Some(field.finish()))
        }
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
        self.window()?;
        self.boxes.clear();
        self.focused = None;
        let cache = self.cache()?;
        let element = unsafe { self.automation.GetFocusedElementBuildCache(&cache) }.map_err(|_| FillError::NoBox)?;
        // The focus lives in the window in front, so it is still ours if that has not changed.
        self.window()?;
        let field = self.describe(&element, 0, true)?.ok_or(FillError::NoBox)?;
        if matches!(field.kind, FieldKind::Button | FieldKind::File | FieldKind::List | FieldKind::Checkbox | FieldKind::Radio) {
            return Err(FillError::NoBox);
        }
        self.boxes.push((element.clone(), field.kind));
        self.focused = Some(element);
        Ok(field)
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
        let found = unsafe { scope.FindAllBuildCache(TreeScope_Descendants, &wanted, &self.cache()?) }?;

        let mut fields = Vec::new();
        for index in 0..unsafe { found.Length() }? {
            let Ok(element) = (unsafe { found.GetElement(index) }) else { continue };
            let Ok(Some(field)) = self.describe(&element, self.boxes.len() as u32, false) else { continue };
            // Plain buttons are not boxes. A file input shows as a button and stays, as yours to fill.
            if !field.visible || field.kind == FieldKind::Button {
                continue;
            }
            self.boxes.push((element, field.kind));
            fields.push(field);
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

impl Writer for Uia {
    fn check(&mut self, id: u32, need: Need) -> Result<(), FillError> {
        self.window()?;
        let (element, _) = self.entry(id)?;
        // A box that has left the page fails any live read.
        unsafe { element.CurrentBoundingRectangle() }?;
        if need == Need::Focus {
            let focused = unsafe { self.automation.GetFocusedElement() }.map_err(|_| FillError::Moved)?;
            if !unsafe { self.automation.CompareElements(&focused, &element) }?.as_bool() {
                return Err(FillError::Moved);
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
            // At most two turns: a three-state box may pass through "mixed".
            for _ in 0..2 {
                if (toggle.CurrentToggleState()? == ToggleState_On) == on {
                    return Ok(());
                }
                toggle.Toggle()?;
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
        if let Some(expand) = opened {
            let _ = unsafe { expand.Collapse() };
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
}
