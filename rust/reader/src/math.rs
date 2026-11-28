use std::{cell::OnceCell, collections::HashMap, fmt::Write, sync::Arc};

use ratex_font::{FontId, katex_ttf_glyph_char};
use ratex_layout::{FallbackGlyphMetrics, LayoutOptions, layout_with_fallback_metrics};
use ratex_parser::{ParseNode, parse_node::StyleStr};
use ratex_types::{
    color::Color, display_item::DisplayItem, math_style::MathStyle, path_command::PathCommand,
};
use resvg::{tiny_skia, usvg};
use ttf_parser::{Face, OutlineBuilder};
use wasm_bindgen::prelude::*;

thread_local! {
    static FALLBACK_FONT: OnceCell<Vec<u8>> = const { OnceCell::new() };
}

#[wasm_bindgen(js_name = "configureMathFont")]
pub fn configure_math_font(bytes: Vec<u8>) -> Result<(), JsError> {
    Face::parse(&bytes, 0).map_err(|_| JsError::new("Invalid math fallback font."))?;
    FALLBACK_FONT.with(|font| _ = font.set(bytes));
    Ok(())
}

#[wasm_bindgen]
pub struct FormulaBitmap {
    pub width: u32,
    pub height: u32,
    pub baseline: f64,
    pub vector: bool,
    bytes: Vec<u8>,
}

#[wasm_bindgen]
impl FormulaBitmap {
    pub fn bytes(self) -> Vec<u8> {
        self.bytes
    }
}

#[wasm_bindgen(js_name = "renderFormula")]
pub fn render_formula(
    tex: &str,
    display: bool,
    color: &str,
    vector: bool,
) -> Option<FormulaBitmap> {
    let color = Color::from_hex(color)?;
    let mut nodes = ratex_parser::parse(tex).ok()?;
    if !display {
        for node in &mut nodes {
            if let ParseNode::GenFrac { mode, .. } = node {
                let mode = *mode;
                let fraction = std::mem::replace(
                    node,
                    ParseNode::Styling {
                        mode,
                        style: StyleStr::Display,
                        body: Vec::new(),
                        loc: None,
                    },
                );
                if let ParseNode::Styling { body, .. } = node {
                    body.push(fraction);
                }
            }
        }
    }
    let options = LayoutOptions {
        style: if display {
            MathStyle::Display
        } else {
            MathStyle::Text
        },
        color,
        ..LayoutOptions::default()
    };
    FALLBACK_FONT.with(|font| {
        let fallback = font.get().and_then(|bytes| Face::parse(bytes, 0).ok());
        let metrics = fallback.as_ref().map_or_else(HashMap::new, |face| {
            let units = f64::from(face.units_per_em());
            tex.chars().filter(|character| !character.is_ascii()).filter_map(|character| {
                let glyph = face.glyph_index(character)?;
                let bounds = face.glyph_bounding_box(glyph)?;
                Some((character, FallbackGlyphMetrics {
                    width: f64::from(face.glyph_hor_advance(glyph)?) / units,
                    height: f64::from(bounds.y_max.max(0)) / units,
                    depth: f64::from(-bounds.y_min.min(0)) / units,
                }))
            }).collect()
        });
        let layout = layout_with_fallback_metrics(&nodes, &options, Arc::new(metrics));
        ratex_layout::validate_layout(&layout).ok()?;
        let list = ratex_layout::to_display_list(&layout);
        let em = if display { 22.0 } else { 30.0 };
        let padding = if display { 2.2 } else { 2.5 };
        let width = (list.width * em + 2.0 * padding).ceil() as u32;
        let height = (list.total_height() * em + 2.0 * padding).ceil() as u32;
        if list.items.is_empty() || width > 1150 || height > 325 || width * height > 170_000 {
            return None;
        }
        let mut svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><g transform="translate({padding} {padding}) scale({em})">"#);
        let mut math_fonts = HashMap::new();
        for item in &list.items {
            write_item(&mut svg, item, &mut math_fonts, fallback.as_ref())?;
            if svg.len() > 400_000 {
                return None;
            }
        }
        svg.push_str("</g></svg>");
        let vector = vector && svg.len() <= 70_000;
        let bytes = if vector {
            svg.into_bytes()
        } else {
            let density = (650_000.0 / f64::from(width * height)).sqrt().min(3.0) as f32;
            let tree = usvg::Tree::from_str(&svg, &usvg::Options::default()).ok()?;
            let mut pixels = tiny_skia::Pixmap::new(
                (width as f32 * density) as u32, (height as f32 * density) as u32,
            )?;
            resvg::render(&tree, tiny_skia::Transform::from_scale(density, density), &mut pixels.as_mut());
            let bytes = pixels.encode_png().ok()?;
            if bytes.len() > 70_000 {
                return None;
            }
            bytes
        };
        Some(FormulaBitmap { width, height, baseline: list.height * em + padding, vector, bytes })
    })
}

fn paint(color: &Color) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        (color.r * 255.0).round() as u8,
        (color.g * 255.0).round() as u8,
        (color.b * 255.0).round() as u8
    )
}

fn write_item<'a>(
    svg: &mut String,
    item: &'a DisplayItem,
    math_fonts: &mut HashMap<&'a str, Option<Face<'static>>>,
    fallback: Option<&Face<'_>>,
) -> Option<()> {
    match item {
        DisplayItem::GlyphPath {
            x,
            y,
            scale,
            font,
            char_code,
            color,
        } => {
            let character = katex_ttf_glyph_char(FontId::parse(font)?, *char_code);
            if character.is_whitespace() {
                return Some(());
            }
            let primary = math_fonts
                .entry(font)
                .or_insert_with(|| {
                    let bytes = ratex_katex_fonts::ttf_bytes(&format!("KaTeX_{font}.ttf"))?;
                    let std::borrow::Cow::Borrowed(bytes) = bytes else {
                        return None;
                    };
                    Face::parse(bytes, 0).ok()
                })
                .as_ref();
            let (face, glyph) = [primary, fallback]
                .into_iter()
                .flatten()
                .find_map(|face| Some((face, face.glyph_index(character)?)))?;
            let factor = scale / f64::from(face.units_per_em());
            write!(svg, r#"<path fill="{}" opacity="{}" transform="translate({x:.6} {y:.6}) scale({factor:.8} {:.8})" d=""#,
                paint(color), color.a, -factor).ok()?;
            face.outline_glyph(glyph, &mut Outline(svg))?;
            svg.push_str("\"/>");
        }
        DisplayItem::Line {
            x,
            y,
            width,
            thickness,
            color,
            dashed,
        } => {
            write!(svg, r#"<line x1="{x:.6}" y1="{y:.6}" x2="{:.6}" y2="{y:.6}" stroke="{}" stroke-width="{thickness:.6}" opacity="{}""#,
                x + width, paint(color), color.a).ok()?;
            if *dashed {
                write!(svg, r#" stroke-dasharray="{:.6}""#, thickness * 3.0).ok()?;
            }
            svg.push_str("/>");
        }
        DisplayItem::Rect {
            x,
            y,
            width,
            height,
            color,
        } => {
            write!(svg, r#"<rect x="{x:.6}" y="{y:.6}" width="{width:.6}" height="{height:.6}" fill="{}" opacity="{}"/>"#,
                paint(color), color.a).ok()?;
        }
        DisplayItem::Path {
            x,
            y,
            commands,
            fill,
            color,
        } => {
            write!(
                svg,
                r#"<path transform="translate({x:.6} {y:.6})" opacity="{}""#,
                color.a
            )
            .ok()?;
            if *fill {
                write!(svg, r#" fill="{}""#, paint(color)).ok()?;
            } else {
                write!(
                    svg,
                    r#" fill="none" stroke="{}" stroke-width="0.04""#,
                    paint(color)
                )
                .ok()?;
            }
            svg.push_str(" d=\"");
            for command in commands {
                match command {
                    PathCommand::MoveTo { x, y } => write!(svg, "M{x:.6} {y:.6}"),
                    PathCommand::LineTo { x, y } => write!(svg, "L{x:.6} {y:.6}"),
                    PathCommand::QuadTo { x1, y1, x, y } => {
                        write!(svg, "Q{x1:.6} {y1:.6} {x:.6} {y:.6}")
                    }
                    PathCommand::CubicTo {
                        x1,
                        y1,
                        x2,
                        y2,
                        x,
                        y,
                    } => write!(svg, "C{x1:.6} {y1:.6} {x2:.6} {y2:.6} {x:.6} {y:.6}"),
                    PathCommand::Close => svg.write_char('Z'),
                }
                .ok()?;
            }
            svg.push_str("\"/>");
        }
    }
    Some(())
}

struct Outline<'a>(&'a mut String);

impl OutlineBuilder for Outline<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        let _ = write!(self.0, "M{x:.2} {y:.2}");
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let _ = write!(self.0, "L{x:.2} {y:.2}");
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let _ = write!(self.0, "Q{x1:.2} {y1:.2} {x:.2} {y:.2}");
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let _ = write!(self.0, "C{x1:.2} {y1:.2} {x2:.2} {y2:.2} {x:.2} {y:.2}");
    }

    fn close(&mut self) {
        self.0.push('Z');
    }
}
