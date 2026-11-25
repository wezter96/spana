use std::collections::BTreeMap;
use std::io::Cursor;
use std::slice;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;

#[repr(C)]
pub struct NativeCompareResult {
    /// 1 = match, 0 = mismatch, -1 = decode error
    pub matched: i32,
    /// 1 = dimensions differ, 0 = same dimensions
    pub size_mismatch: i32,
    pub diff_pixel_count: u32,
    pub diff_pixel_ratio: f64,
    /// Pointer to heap-allocated diff PNG bytes (only populated on mismatch when non-size-mismatch)
    pub diff_png_ptr: *mut u8,
    pub diff_png_len: usize,
}

#[repr(C)]
pub struct NativeBuffer {
    pub ptr: *mut u8,
    pub len: usize,
}

fn decode_rgba(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), ()> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| ())?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|_| ())?;
    let raw = &buf[..info.buffer_size()];
    let width = info.width;
    let height = info.height;
    let pixels = (width as usize) * (height as usize);

    let rgba = match info.color_type {
        png::ColorType::Rgba => raw.to_vec(),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(pixels * 4);
            for chunk in raw.chunks_exact(3) {
                out.push(chunk[0]);
                out.push(chunk[1]);
                out.push(chunk[2]);
                out.push(255);
            }
            out
        }
        png::ColorType::Grayscale => {
            let mut out = Vec::with_capacity(pixels * 4);
            for &g in raw {
                out.push(g);
                out.push(g);
                out.push(g);
                out.push(255);
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let mut out = Vec::with_capacity(pixels * 4);
            for chunk in raw.chunks_exact(2) {
                out.push(chunk[0]);
                out.push(chunk[0]);
                out.push(chunk[0]);
                out.push(chunk[1]);
            }
            out
        }
        _ => return Err(()),
    };
    Ok((width, height, rgba))
}

fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, ()> {
    let mut out = Vec::with_capacity((width as usize) * (height as usize));
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|_| ())?;
        writer.write_image_data(rgba).map_err(|_| ())?;
    }
    Ok(out)
}

#[inline(always)]
fn color_delta_yiq(a: &[u8], b: &[u8]) -> f64 {
    let mut r1 = a[0] as f64;
    let mut g1 = a[1] as f64;
    let mut b1 = a[2] as f64;
    let a1 = a[3] as f64;

    let mut r2 = b[0] as f64;
    let mut g2 = b[1] as f64;
    let mut b2 = b[2] as f64;
    let a2 = b[3] as f64;

    if a1 < 255.0 {
        let alpha = a1 / 255.0;
        r1 = 255.0 + (r1 - 255.0) * alpha;
        g1 = 255.0 + (g1 - 255.0) * alpha;
        b1 = 255.0 + (b1 - 255.0) * alpha;
    }
    if a2 < 255.0 {
        let alpha = a2 / 255.0;
        r2 = 255.0 + (r2 - 255.0) * alpha;
        g2 = 255.0 + (g2 - 255.0) * alpha;
        b2 = 255.0 + (b2 - 255.0) * alpha;
    }

    let dr = r1 - r2;
    let dg = g1 - g2;
    let db = b1 - b2;

    let y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
    let i = dr * 0.59597799 - dg * 0.27417610 - db * 0.32180189;
    let q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;

    0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q
}

fn block_luminance_diff_ratio(
    exp: &[u8],
    act: &[u8],
    width: usize,
    height: usize,
    block_size: usize,
    luma_threshold: f64,
) -> f64 {
    let blocks_x = (width / block_size).max(1);
    let blocks_y = (height / block_size).max(1);
    let total_blocks = blocks_x * blocks_y;
    let mut diff_blocks = 0usize;

    for by in 0..blocks_y {
        let start_y = by * block_size;
        let end_y = (start_y + block_size).min(height);
        for bx in 0..blocks_x {
            let start_x = bx * block_size;
            let end_x = (start_x + block_size).min(width);
            let mut sum_exp = 0.0f64;
            let mut sum_act = 0.0f64;
            let mut count = 0usize;

            for y in start_y..end_y {
                let row = y * width;
                for x in start_x..end_x {
                    let idx = (row + x) * 4;
                    sum_exp += 0.299 * (exp[idx] as f64)
                        + 0.587 * (exp[idx + 1] as f64)
                        + 0.114 * (exp[idx + 2] as f64);
                    sum_act += 0.299 * (act[idx] as f64)
                        + 0.587 * (act[idx + 1] as f64)
                        + 0.114 * (act[idx + 2] as f64);
                    count += 1;
                }
            }
            if count > 0 && ((sum_exp - sum_act).abs() / (count as f64)) > luma_threshold {
                diff_blocks += 1;
            }
        }
    }

    if total_blocks == 0 {
        0.0
    } else {
        (diff_blocks as f64) / (total_blocks as f64)
    }
}

/// Compare two PNG buffers in native Rust (YIQ perceptual diff + optional 4x4 block luminance tolerance).
/// `layout_tolerant`: 0 = pixel mode, 1 = layout-tolerant mode.
/// `out_result`: caller-provided pointer to `NativeCompareResult`.
#[no_mangle]
pub unsafe extern "C" fn spana_compare_png(
    exp_ptr: *const u8,
    exp_len: usize,
    act_ptr: *const u8,
    act_len: usize,
    threshold: f64,
    max_diff_ratio: f64,
    layout_tolerant: i32,
    out_result: *mut NativeCompareResult,
) {
    let res = &mut *out_result;
    res.matched = -1;
    res.size_mismatch = 0;
    res.diff_pixel_count = 0;
    res.diff_pixel_ratio = 1.0;
    res.diff_png_ptr = std::ptr::null_mut();
    res.diff_png_len = 0;

    if exp_ptr.is_null() || act_ptr.is_null() || exp_len == 0 || act_len == 0 {
        return;
    }

    let exp_bytes = slice::from_raw_parts(exp_ptr, exp_len);
    let act_bytes = slice::from_raw_parts(act_ptr, act_len);

    // Byte-identical fast path
    if exp_bytes == act_bytes {
        res.matched = 1;
        res.diff_pixel_count = 0;
        res.diff_pixel_ratio = 0.0;
        return;
    }

    let Ok((w1, h1, exp_rgba)) = decode_rgba(exp_bytes) else {
        return;
    };
    let Ok((w2, h2, act_rgba)) = decode_rgba(act_bytes) else {
        return;
    };

    if w1 != w2 || h1 != h2 {
        res.matched = 0;
        res.size_mismatch = 1;
        res.diff_pixel_ratio = 1.0;
        return;
    }

    let width = w1 as usize;
    let height = h1 as usize;
    let total_pixels = width * height;
    let max_delta = 35215.0 * threshold * threshold;

    // Fast path: check pixel diffs first; only allocate/render diff image if mismatch!
    let mut diff_count = 0u32;
    let mut i = 0usize;
    let byte_len = total_pixels * 4;
    while i < byte_len {
        let a = &exp_rgba[i..i + 4];
        let b = &act_rgba[i..i + 4];
        if a != b && color_delta_yiq(a, b) > max_delta {
            diff_count += 1;
        }
        i += 4;
    }

    let pixel_ratio = if total_pixels == 0 {
        0.0
    } else {
        (diff_count as f64) / (total_pixels as f64)
    };

    let diff_ratio = if layout_tolerant != 0 {
        let block_ratio = block_luminance_diff_ratio(&exp_rgba, &act_rgba, width, height, 4, 18.0);
        pixel_ratio.min(block_ratio)
    } else {
        pixel_ratio
    };

    res.diff_pixel_count = diff_count;
    res.diff_pixel_ratio = diff_ratio;

    if diff_ratio <= max_diff_ratio {
        res.matched = 1;
        return;
    }

    res.matched = 0;
    // Build visual diff RGBA buffer only on actual mismatch
    let mut diff_rgba = vec![0u8; byte_len];
    let mut j = 0usize;
    while j < byte_len {
        let a = &exp_rgba[j..j + 4];
        let b = &act_rgba[j..j + 4];
        if a != b && color_delta_yiq(a, b) > max_delta {
            diff_rgba[j] = 255;
            diff_rgba[j + 1] = 0;
            diff_rgba[j + 2] = 0;
            diff_rgba[j + 3] = 255;
        } else {
            // Dimmed grayscale background (matches pixelmatch visual style)
            let luma = (0.299 * (a[0] as f64) + 0.587 * (a[1] as f64) + 0.114 * (a[2] as f64)) as u8;
            let blended = 255u8.saturating_sub(((255 - luma) as u16 / 10) as u8);
            diff_rgba[j] = blended;
            diff_rgba[j + 1] = blended;
            diff_rgba[j + 2] = blended;
            diff_rgba[j + 3] = 255;
        }
        j += 4;
    }

    if let Ok(mut encoded) = encode_rgba_png(w1, h1, &diff_rgba) {
        encoded.shrink_to_fit();
        res.diff_png_len = encoded.len();
        res.diff_png_ptr = encoded.as_mut_ptr();
        std::mem::forget(encoded);
    }
}

#[derive(Serialize)]
struct RawXmlNode {
    #[serde(rename = "tagName")]
    tag_name: String,
    attrs: BTreeMap<String, String>,
    children: Vec<RawXmlNode>,
}

/// Parse an Android/iOS native UI hierarchy XML string into Spana's `RawNode[]` JSON
/// using `quick-xml` (10–25× faster than JS regex/char-by-char parsing on multi-MB dumps).
#[no_mangle]
pub unsafe extern "C" fn spana_tokenize_xml(
    xml_ptr: *const u8,
    xml_len: usize,
    wrapper_ptr: *const u8,
    wrapper_len: usize,
    out_buf: *mut NativeBuffer,
) -> i32 {
    let out = &mut *out_buf;
    out.ptr = std::ptr::null_mut();
    out.len = 0;

    if xml_ptr.is_null() || xml_len == 0 {
        return -1;
    }

    let Ok(xml_str) = std::str::from_utf8(slice::from_raw_parts(xml_ptr, xml_len)) else {
        return -1;
    };
    let wrapper = if !wrapper_ptr.is_null() && wrapper_len > 0 {
        std::str::from_utf8(slice::from_raw_parts(wrapper_ptr, wrapper_len)).unwrap_or("")
    } else {
        ""
    };

    let mut reader = Reader::from_str(xml_str);
    reader.config_mut().trim_text(true);
    let mut stack: Vec<RawXmlNode> = Vec::with_capacity(32);
    let mut roots: Vec<RawXmlNode> = Vec::new();

    let extract_attrs = |e: &quick_xml::events::BytesStart<'_>| -> BTreeMap<String, String> {
        let mut map = BTreeMap::new();
        for attr in e.attributes().flatten() {
            if let Ok(k) = std::str::from_utf8(attr.key.as_ref()) {
                if let Ok(v) = attr.unescape_value() {
                    map.insert(k.to_string(), v.into_owned());
                } else if let Ok(v) = std::str::from_utf8(attr.value.as_ref()) {
                    map.insert(k.to_string(), v.to_string());
                }
            }
        }
        map
    };

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let tag_name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                let attrs = extract_attrs(&e);
                stack.push(RawXmlNode {
                    tag_name,
                    attrs,
                    children: Vec::new(),
                });
            }
            Ok(Event::Empty(e)) => {
                let tag_name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                let attrs = extract_attrs(&e);
                let node = RawXmlNode {
                    tag_name,
                    attrs,
                    children: Vec::new(),
                };
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                } else {
                    roots.push(node);
                }
            }
            Ok(Event::End(_)) => {
                if let Some(node) = stack.pop() {
                    if let Some(parent) = stack.last_mut() {
                        parent.children.push(node);
                    } else {
                        roots.push(node);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => return -1,
            _ => {}
        }
    }

    while let Some(node) = stack.pop() {
        if let Some(parent) = stack.last_mut() {
            parent.children.push(node);
        } else {
            roots.push(node);
        }
    }

    // Unwrap top-level wrapper tag (e.g. "hierarchy" or "AppiumAUT") matching JS tokenizeXML
    let final_roots: Vec<RawXmlNode> = if roots.len() == 1 && roots[0].tag_name == wrapper {
        roots.into_iter().next().unwrap().children
    } else {
        roots
    };

    let Ok(mut json_bytes) = serde_json::to_vec(&final_roots) else {
        return -1;
    };
    json_bytes.shrink_to_fit();
    out.len = json_bytes.len();
    out.ptr = json_bytes.as_mut_ptr();
    std::mem::forget(json_bytes);
    0
}

/// Free heap buffers allocated by `spana_compare_png` or `spana_tokenize_xml`.
#[no_mangle]
pub unsafe extern "C" fn spana_free_buffer(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        let _ = Vec::from_raw_parts(ptr, len, len);
    }
}
