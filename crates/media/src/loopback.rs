//! What this PC is playing, which on a call is everyone else. Windows mixes it down to the format
//! asked for, so what comes out is 16 kHz mono, the same as the microphone.
//!
//! The two recordings have to stay on one clock for the lines of a call to fall in the right order,
//! so anything Windows does not deliver is filled with silence, going by the time that has passed.

use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows::core::Result;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};

pub const RATE: u32 = 16_000;
const LOOK_EVERY: Duration = Duration::from_millis(20);
/// In units of 100 ns.
const BUFFER: i64 = 2_000_000;
/// Sound moves to another output when headphones connect, sometimes in the middle of a call.
const CHECK_OUTPUT_EVERY: Duration = Duration::from_secs(2);
/// Sound arrives in bursts, so being this far behind is normal and is not silence yet.
const FILL_WHEN_BEHIND: u64 = RATE as u64 / 4;

/// Listening until dropped. A PC with nothing to open gives a silent recording, not a failure,
/// because a call can still be noted from the microphone alone.
pub struct Loopback {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Loopback {
    /// `sink` gets 16-bit samples from `began` onward, with nothing missing.
    pub fn start(began: Instant, mut sink: impl FnMut(&[i16]) + Send + 'static) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = thread::spawn(move || run(&stopping, began, &mut sink));
        Self { stop, thread: Some(thread) }
    }
}

impl Drop for Loopback {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// How many samples are owed, once enough have gone missing to be sure they will not arrive.
fn missing(elapsed: Duration, sent: u64) -> u64 {
    let due = (elapsed.as_secs_f64() * f64::from(RATE)) as u64;
    Some(due.saturating_sub(sent)).filter(|behind| *behind >= FILL_WHEN_BEHIND).unwrap_or(0)
}

struct Writer<'a> {
    began: Instant,
    sent: u64,
    sink: &'a mut dyn FnMut(&[i16]),
}

impl Writer<'_> {
    fn write(&mut self, samples: &[i16]) {
        (self.sink)(samples);
        self.sent += samples.len() as u64;
    }

    fn fill(&mut self) {
        let owed = missing(self.began.elapsed(), self.sent);
        if owed > 0 {
            self.write(&vec![0; owed as usize]);
        }
    }
}

fn default_output(devices: &IMMDeviceEnumerator) -> Result<(IMMDevice, String)> {
    unsafe {
        let device = devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let raw = device.GetId()?;
        let id = raw.to_string().unwrap_or_default();
        CoTaskMemFree(Some(raw.0 as *const _));
        Ok((device, id))
    }
}

/// Listens to one output until it stops being the default or `stop` is set.
fn listen(stop: &AtomicBool, writer: &mut Writer) -> Result<()> {
    unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let (device, output) = default_output(&devices)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: 1,
            nSamplesPerSec: RATE,
            nAvgBytesPerSec: RATE * 2,
            nBlockAlign: 2,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, BUFFER, 0, &format, None)?;
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        let mut checked = Instant::now();
        while !stop.load(Ordering::Relaxed) {
            thread::sleep(LOOK_EVERY);
            while capture.GetNextPacketSize()? > 0 {
                let (mut data, mut frames, mut state) = (null_mut(), 0u32, 0u32);
                capture.GetBuffer(&mut data, &mut frames, &mut state, None, None)?;
                if state & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                    writer.write(&vec![0; frames as usize]);
                } else {
                    writer.write(std::slice::from_raw_parts(data.cast::<i16>(), frames as usize));
                }
                capture.ReleaseBuffer(frames)?;
            }
            writer.fill();
            if checked.elapsed() >= CHECK_OUTPUT_EVERY {
                checked = Instant::now();
                if default_output(&devices)?.1 != output {
                    break;
                }
            }
        }
        client.Stop()
    }
}

fn run(stop: &AtomicBool, began: Instant, sink: &mut dyn FnMut(&[i16])) {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let mut writer = Writer { began, sent: 0, sink };
    while !stop.load(Ordering::Relaxed) {
        // An output can vanish as it is opened, and the time still has to be counted.
        if listen(stop, &mut writer).is_err() {
            thread::sleep(LOOK_EVERY);
            writer.fill();
        }
    }
    writer.fill();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bursts_are_left_alone_and_real_gaps_are_filled() {
        assert_eq!(missing(Duration::from_millis(100), 0), 0);
        assert_eq!(missing(Duration::from_secs(1), RATE as u64 - 100), 0);
        assert_eq!(missing(Duration::from_secs(1), 0), RATE as u64);
        assert_eq!(missing(Duration::from_secs(2), RATE as u64), RATE as u64);
    }

    #[test]
    fn being_ahead_is_not_owing() {
        assert_eq!(missing(Duration::from_secs(1), RATE as u64 * 2), 0);
    }

    /// Prints what Windows really delivers. Nothing is kept, and only amounts are shown.
    #[test]
    #[ignore = "listens to what this PC is playing"]
    fn what_windows_delivers() {
        let seconds = std::env::var("LOOPBACK_SECONDS").ok().and_then(|text| text.parse().ok()).unwrap_or(4);
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let totals = Arc::new(std::sync::Mutex::new((0u64, 0u64, 0u64, 0i32)));
        let seen = totals.clone();
        let began = Instant::now();
        let thread = thread::spawn(move || {
            run(&stopping, began, &mut |samples| {
                let mut seen = seen.lock().unwrap();
                seen.0 += samples.len() as u64;
                seen.1 += 1;
                seen.2 += samples.iter().filter(|sample| **sample != 0).count() as u64;
                seen.3 = seen.3.max(samples.iter().map(|sample| i32::from(*sample).abs()).max().unwrap_or(0));
            });
        });
        thread::sleep(Duration::from_secs(seconds));
        stop.store(true, Ordering::Relaxed);
        thread.join().unwrap();
        let (samples, pieces, sound, peak) = *totals.lock().unwrap();
        let elapsed = began.elapsed().as_secs_f64();
        println!("{elapsed:.2} s: {samples} samples, expected about {:.0}, in {pieces} pieces, {sound} not silent, peak {peak}", elapsed * f64::from(RATE));
        let off = (samples as f64 / f64::from(RATE) - elapsed).abs();
        assert!(off < 0.3, "the recording is {off:.2} s away from the clock");
    }
}
