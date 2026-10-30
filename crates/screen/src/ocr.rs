//! Windows' own OCR and JPEG encoder. Both run on this machine. The calls block,
//! so callers keep them off the UI thread.

use windows::Graphics::Imaging::{BitmapEncoder, BitmapPixelFormat, BitmapInterpolationMode, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Storage::Streams::{DataReader, InMemoryRandomAccessStream};

use crate::{Frame, ScreenError};

/// The long edge sent to a vision model. Larger only costs more tokens.
const MAX_IMAGE_EDGE: u32 = 1568;

fn bitmap(frame: &Frame) -> windows::core::Result<SoftwareBitmap> {
    let buffer = CryptographicBuffer::CreateFromByteArray(&frame.bgra)?;
    SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, frame.width as i32, frame.height as i32)
}

/// All the text Windows can read in a frame, one line per visual line.
pub fn ocr(frame: &Frame) -> Result<String, ScreenError> {
    let run = || -> windows::core::Result<String> {
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
        let result = engine.RecognizeAsync(&bitmap(frame)?)?.join()?;
        let mut lines = Vec::new();
        for line in result.Lines()? {
            lines.push(line.Text()?.to_string());
        }
        Ok(lines.join("\n"))
    };
    run().map_err(|e| ScreenError::Ocr(e.message()))
}

pub fn to_jpeg(frame: &Frame) -> Result<Vec<u8>, ScreenError> {
    let run = || -> windows::core::Result<Vec<u8>> {
        let stream = InMemoryRandomAccessStream::new()?;
        let encoder = BitmapEncoder::CreateAsync(BitmapEncoder::JpegEncoderId()?, &stream)?.join()?;
        encoder.SetSoftwareBitmap(&bitmap(frame)?)?;

        let longest = frame.width.max(frame.height);
        if longest > MAX_IMAGE_EDGE {
            let scale = MAX_IMAGE_EDGE as f64 / longest as f64;
            let transform = encoder.BitmapTransform()?;
            transform.SetInterpolationMode(BitmapInterpolationMode::Fant)?;
            transform.SetScaledWidth((frame.width as f64 * scale) as u32)?;
            transform.SetScaledHeight((frame.height as f64 * scale) as u32)?;
        }
        encoder.FlushAsync()?.join()?;

        stream.Seek(0)?;
        let size = stream.Size()? as u32;
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
        reader.LoadAsync(size)?.join()?;
        let mut bytes = vec![0u8; size as usize];
        reader.ReadBytes(&mut bytes)?;
        Ok(bytes)
    };
    run().map_err(|e| ScreenError::Capture(e.message()))
}
