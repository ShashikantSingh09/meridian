//! The system's volume, screen brightness and battery, reported when they change, so the island
//! can answer the keys and the charger. Volume and brightness call back. Windows offers no
//! callback for the battery without a window, so that one is a cheap look every two seconds.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use windows::core::{implement, Result, BSTR, PCWSTR};
use windows::Devices::Power::Battery;
use windows::Win32::Media::Audio::Endpoints::{
    IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl,
};
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator, AUDIO_VOLUME_NOTIFICATION_DATA};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoSetProxyBlanket, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
    EOAC_NONE, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Rpc::{RPC_C_AUTHN_NONE, RPC_C_AUTHN_WINNT};
use windows::Win32::System::Wmi::{
    IWbemClassObject, IWbemLocator, WbemLocator, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY,
    WBEM_GENERIC_FLAG_TYPE, WBEM_INFINITE,
};

/// How often to check whether sound has moved to another output.
const CHECK_OUTPUT_EVERY: Duration = Duration::from_secs(3);
const CHECK_BATTERY_EVERY: Duration = Duration::from_secs(2);
/// The charge levels worth interrupting for.
const LOW: [u8; 3] = [20, 10, 5];
/// `BatteryFlag`: this PC has no battery.
const NO_BATTERY: u8 = 128;
/// `SystemStatusFlag`: battery saver is on.
const SAVER_ON: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Level {
    Volume { percent: u8, muted: bool },
    Brightness { percent: u8 },
    Battery {
        percent: u8,
        plugged: bool,
        saver: bool,
        /// On battery, as Windows estimates it.
        seconds_left: Option<u32>,
        /// Charging, worked out from the charge rate.
        seconds_to_full: Option<u32>,
        watts: Option<u32>,
        /// Capacity left compared with when new, as a percentage.
        health: Option<u8>,
    },
}

type Report = Arc<dyn Fn(Level) + Send + Sync>;

#[implement(IAudioEndpointVolumeCallback)]
struct VolumeChanged(Report);

impl IAudioEndpointVolumeCallback_Impl for VolumeChanged_Impl {
    fn OnNotify(&self, data: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> Result<()> {
        if let Some(data) = unsafe { data.as_ref() } {
            (self.0)(Level::Volume { percent: (data.fMasterVolume * 100.0).round() as u8, muted: data.bMuted.as_bool() });
        }
        Ok(())
    }
}

/// The default output, and its name so a change of output can be noticed.
fn output() -> Result<(IAudioEndpointVolume, String)> {
    unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
        // The caller owns this string, and this runs every few seconds.
        let raw = device.GetId()?;
        let id = raw.to_string().unwrap_or_default();
        CoTaskMemFree(Some(raw.0 as *const _));
        Ok((device.Activate(CLSCTX_ALL, None)?, id))
    }
}

/// Sets the sound of the default output, and says where it ended up. `change` is in percent.
pub fn change_volume(percent: Option<u8>, change: Option<i8>, muted: Option<bool>) -> Result<(u8, bool)> {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let (volume, _) = output()?;
    unsafe {
        let now = volume.GetMasterVolumeLevelScalar()?;
        let wanted = percent.map(|p| f32::from(p) / 100.0).or(change.map(|c| now + f32::from(c) / 100.0));
        if let Some(level) = wanted {
            volume.SetMasterVolumeLevelScalar(level.clamp(0.0, 1.0), std::ptr::null())?;
            // Choosing a volume means wanting to hear it.
            if muted.is_none() {
                volume.SetMute(false, std::ptr::null())?;
            }
        }
        if let Some(muted) = muted {
            volume.SetMute(muted, std::ptr::null())?;
        }
        Ok(((volume.GetMasterVolumeLevelScalar()? * 100.0).round() as u8, volume.GetMute()?.as_bool()))
    }
}

fn watch_volume(report: Report) {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let callback: IAudioEndpointVolumeCallback = VolumeChanged(report).into();
    let mut current: Option<(IAudioEndpointVolume, String)> = None;
    loop {
        if let Ok((volume, id)) = output() {
            if current.as_ref().is_none_or(|(_, known)| *known != id) {
                if let Some((old, _)) = current.take() {
                    let _ = unsafe { old.UnregisterControlChangeNotify(&callback) };
                }
                if unsafe { volume.RegisterControlChangeNotify(&callback) }.is_ok() {
                    current = Some((volume, id));
                }
            }
        }
        std::thread::sleep(CHECK_OUTPUT_EVERY);
    }
}

fn brightness_of(object: &IWbemClassObject) -> Option<u8> {
    let mut value = Default::default();
    let name: Vec<u16> = "Brightness\0".encode_utf16().collect();
    unsafe { object.Get(PCWSTR(name.as_ptr()), 0, &mut value, None, None) }.ok()?;
    i32::try_from(&value).ok().and_then(|level| u8::try_from(level).ok())
}

/// Windows reports brightness only for screens it controls, which means a laptop's own. On a
/// desktop this returns straight away, and the island simply never shows brightness.
fn watch_brightness(report: Report) -> Result<()> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_ALL)?;
        let services = locator.ConnectServer(&BSTR::from("ROOT\\WMI"), &BSTR::new(), &BSTR::new(), &BSTR::new(), 0, &BSTR::new(), None)?;
        CoSetProxyBlanket(&services, RPC_C_AUTHN_WINNT, RPC_C_AUTHN_NONE, None, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, None, EOAC_NONE)?;
        let flags = WBEM_GENERIC_FLAG_TYPE(WBEM_FLAG_FORWARD_ONLY.0 | WBEM_FLAG_RETURN_IMMEDIATELY.0);
        let events = services.ExecNotificationQuery(&BSTR::from("WQL"), &BSTR::from("SELECT * FROM WmiMonitorBrightnessEvent"), flags, None)?;
        loop {
            let mut found = [None];
            let mut returned = 0;
            events.Next(WBEM_INFINITE, &mut found, &mut returned).ok()?;
            if let Some(percent) = found[0].as_ref().and_then(brightness_of) {
                report(Level::Brightness { percent });
            }
        }
    }
}

/// What the battery was doing at one look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Power {
    percent: u8,
    plugged: bool,
    saver: bool,
}

/// Whether a change is worth showing: the charger, battery saver, full, or falling to a low mark.
fn worth_showing(before: Power, now: Power) -> bool {
    before.plugged != now.plugged
        || before.saver != now.saver
        || (now.plugged && now.percent == 100 && before.percent < 100)
        || (!now.plugged && LOW.iter().any(|mark| before.percent > *mark && now.percent <= *mark))
}

fn power() -> Option<(Power, Option<u32>)> {
    let mut status = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut status) }.ok()?;
    if status.BatteryFlag & NO_BATTERY != 0 || status.BatteryLifePercent > 100 {
        return None;
    }
    let left = (status.BatteryLifeTime != u32::MAX).then_some(status.BatteryLifeTime);
    Some((Power { percent: status.BatteryLifePercent, plugged: status.ACLineStatus == 1, saver: status.SystemStatusFlag == SAVER_ON }, left))
}

/// The charge in percent and whether the charger is in, or nothing on a PC with no battery. One cheap call.
pub fn battery_now() -> Option<(u8, bool)> {
    power().map(|(power, _)| (power.percent, power.plugged))
}

/// Charge rate and capacity, which Windows gives only through this report.
fn details() -> Option<(Option<u32>, Option<u32>, Option<u8>)> {
    let report = Battery::AggregateBattery().ok()?.GetReport().ok()?;
    let read = |value: windows::core::Result<windows::Foundation::IReference<i32>>| value.ok()?.Value().ok();
    let rate = read(report.ChargeRateInMilliwatts()).filter(|rate| *rate > 0);
    let full = read(report.FullChargeCapacityInMilliwattHours());
    let left = read(report.RemainingCapacityInMilliwattHours());
    let design = read(report.DesignCapacityInMilliwattHours());
    let to_full = match (rate, full, left) {
        (Some(rate), Some(full), Some(left)) if full > left => Some(((full - left) as u64 * 3600 / rate as u64) as u32),
        _ => None,
    };
    let health = match (full, design) {
        (Some(full), Some(design)) if design > 0 => Some((full as u64 * 100 / design as u64).min(100) as u8),
        _ => None,
    };
    Some((to_full, rate.map(|rate| (rate / 1000) as u32), health))
}

fn watch_battery(report: Report) {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let Some((mut last, _)) = power() else { return };
    loop {
        std::thread::sleep(CHECK_BATTERY_EVERY);
        let Some((now, seconds_left)) = power() else { continue };
        if worth_showing(last, now) {
            let (seconds_to_full, watts, health) = details().unwrap_or_default();
            report(Level::Battery {
                percent: now.percent,
                plugged: now.plugged,
                saver: now.saver,
                seconds_left,
                seconds_to_full: seconds_to_full.filter(|_| now.plugged),
                watts: watts.filter(|_| now.plugged),
                health,
            });
        }
        last = now;
    }
}

/// Starts watching. `on_change` runs on a background thread for each change.
pub fn watch(on_change: impl Fn(Level) + Send + Sync + 'static) {
    let report: Report = Arc::new(on_change);
    let (volume, battery) = (report.clone(), report.clone());
    std::thread::spawn(move || watch_volume(volume));
    std::thread::spawn(move || watch_battery(battery));
    std::thread::spawn(move || {
        let _ = watch_brightness(report);
    });
}

/// The output's volume from 0 to 1, for the live test.
pub fn volume_now() -> Result<f32> {
    unsafe { output()?.0.GetMasterVolumeLevelScalar() }
}

/// Sets the output's volume from 0 to 1, for the live test.
pub fn set_volume(level: f32) -> Result<()> {
    unsafe { output()?.0.SetMasterVolumeLevelScalar(level, std::ptr::null()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn at(percent: u8, plugged: bool) -> Power {
        Power { percent, plugged, saver: false }
    }

    #[test]
    fn the_charger_always_shows() {
        assert!(worth_showing(at(64, false), at(64, true)));
        assert!(worth_showing(at(64, true), at(64, false)));
    }

    #[test]
    fn low_marks_show_once_on_the_way_down() {
        assert!(worth_showing(at(21, false), at(20, false)));
        assert!(!worth_showing(at(20, false), at(19, false)));
        assert!(worth_showing(at(11, false), at(10, false)));
        assert!(worth_showing(at(6, false), at(5, false)));
        assert!(!worth_showing(at(21, true), at(20, true)), "not while charging");
    }

    #[test]
    fn full_shows_once() {
        assert!(worth_showing(at(99, true), at(100, true)));
        assert!(!worth_showing(at(100, true), at(100, true)));
    }

    #[test]
    fn ordinary_drain_shows_nothing() {
        assert!(!worth_showing(at(64, false), at(63, false)));
    }

    #[test]
    fn battery_saver_shows() {
        assert!(worth_showing(at(40, false), Power { saver: true, ..at(40, false) }));
    }
}
