use jpeg_encoder::{ColorType, Encoder, SamplingFactor};
use wasm_bindgen::prelude::*;

const MAX_PIXELS: usize = 5_000_000;
const QUALITIES: [u8; 5] = [88, 70, 49, 30, 15];

#[wasm_bindgen(js_name = encodePageJpeg)]
pub fn encode_page_jpeg(
    pixels: &[u8],
    width: u16,
    height: u16,
    max_bytes: usize,
) -> Result<Vec<u8>, JsError> {
    let pixel_count = usize::from(width) * usize::from(height);
    if pixel_count == 0 || pixel_count > MAX_PIXELS || pixels.len() != pixel_count * 4 {
        return Err(JsError::new("Invalid PDF page raster."));
    }

    let mut jpeg = Vec::new();
    for quality in QUALITIES {
        let mut encoder = Encoder::new(&mut jpeg, quality);
        encoder.set_sampling_factor(SamplingFactor::F_1_1);
        encoder
            .encode(pixels, width, height, ColorType::Rgba)
            .map_err(|_| JsError::new("Could not encode the PDF page."))?;
        if jpeg.len() <= max_bytes {
            return Ok(jpeg);
        }
        jpeg.clear();
    }
    Err(JsError::new("PDF page is too detailed to preview."))
}
