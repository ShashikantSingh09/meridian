//! Real desktop blur behind the island. A transparent webview cannot sample what
//! is behind its window, and DWM acrylic fills the whole window rectangle. A
//! Windows.UI.Composition visual below the webview can do what neither can: a
//! host backdrop in an antialiased rounded shape that follows the island.
//!
//! Everything here is optional. Any failure leaves `active()` false and the UI
//! falls back to a tinted surface.

use std::cell::RefCell;

use windows::core::{Interface, BOOL};
use windows::System::DispatcherQueueController;
use windows::UI::Composition::Desktop::DesktopWindowTarget;
use windows::UI::Composition::{CompositionRoundedRectangleGeometry, Compositor, SpriteVisual};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_HOSTBACKDROPBRUSH};
use windows::Win32::System::WinRT::Composition::ICompositorDesktopInterop;
use windows::Win32::System::WinRT::{
    CreateDispatcherQueueController, DispatcherQueueOptions, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT,
};
use windows_numerics::{Vector2, Vector3};

struct Glass {
    _controller: DispatcherQueueController,
    _target: DesktopWindowTarget,
    visual: SpriteVisual,
    shape: CompositionRoundedRectangleGeometry,
}

// Composition objects belong to the thread that made them: the main thread.
thread_local! {
    static GLASS: RefCell<Option<Glass>> = const { RefCell::new(None) };
}

fn build(hwnd: HWND) -> windows::core::Result<Glass> {
    let enable = BOOL::from(true);
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_HOSTBACKDROPBRUSH,
            &enable as *const BOOL as *const _,
            std::mem::size_of::<BOOL>() as u32,
        )?;
    }

    let options = DispatcherQueueOptions {
        dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
        threadType: DQTYPE_THREAD_CURRENT,
        apartmentType: DQTAT_COM_NONE,
    };
    let controller = unsafe { CreateDispatcherQueueController(options)? };
    let compositor = Compositor::new()?;
    let interop: ICompositorDesktopInterop = compositor.cast()?;
    // false: below the window's content, so the webview draws over it.
    let target = unsafe { interop.CreateDesktopWindowTarget(hwnd, false)? };

    let visual = compositor.CreateSpriteVisual()?;
    visual.SetBrush(&compositor.CreateHostBackdropBrush()?)?;
    let shape = compositor.CreateRoundedRectangleGeometry()?;
    visual.SetClip(&compositor.CreateGeometricClipWithGeometry(&shape)?)?;

    let root = compositor.CreateContainerVisual()?;
    root.Children()?.InsertAtTop(&visual)?;
    target.SetRoot(&root)?;

    Ok(Glass { _controller: controller, _target: target, visual, shape })
}

/// Must run on the main thread. Returns whether the backdrop is in place.
pub fn attach(hwnd: HWND) -> bool {
    match build(hwnd) {
        Ok(glass) => {
            GLASS.with(|g| *g.borrow_mut() = Some(glass));
            true
        }
        Err(err) => {
            eprintln!("native glass unavailable: {err}");
            false
        }
    }
}

pub fn active() -> bool {
    GLASS.with(|g| g.borrow().is_some())
}

/// Moves the backdrop to the island. Physical pixels, window-relative.
pub fn place(x: f32, y: f32, w: f32, h: f32, r: f32) {
    GLASS.with(|g| {
        let glass = g.borrow();
        let Some(glass) = glass.as_ref() else { return };
        let _ = glass.visual.SetOffset(Vector3 { X: x, Y: y, Z: 0.0 });
        let size = Vector2 { X: w, Y: h };
        let _ = glass.visual.SetSize(size);
        let _ = glass.shape.SetSize(size);
        let _ = glass.shape.SetCornerRadius(Vector2 { X: r, Y: r });
    });
}
