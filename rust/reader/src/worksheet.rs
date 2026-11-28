use std::{collections::HashMap, sync::LazyLock};

use regex::Regex;
use roxmltree::{Document, Node};
use serde::Serialize;
use wasm_bindgen::prelude::*;

const MAX_ROWS: usize = 8_192;
const MAX_COLUMNS: usize = 256;
const MAX_CELLS: usize = 80_000;
const MAX_TEXT: usize = 400_000;
const MAX_MERGES: usize = 4_096;
const RELATIONSHIP_NAMESPACES: [&str; 2] = [
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
];

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CellStyle {
    bold: bool,
    italic: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    font_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    align: Option<String>,
    wrap: bool,
    #[serde(skip)]
    format: u32,
}

type Cell = (usize, usize, String, usize, bool);
type Merge = (usize, usize, usize, usize);

#[derive(Default, Serialize)]
struct Grid {
    rows: Vec<f64>,
    columns: Vec<f64>,
    cells: Vec<Cell>,
    merges: Vec<Merge>,
    truncated: bool,
}

#[derive(Serialize)]
struct Worksheet<'a> {
    #[serde(flatten)]
    grid: Grid,
    styles: &'a [CellStyle],
}

#[wasm_bindgen]
pub struct Workbook {
    sheets: Vec<(String, Option<String>)>,
    shared: Vec<String>,
    styles: Vec<CellStyle>,
}

#[wasm_bindgen]
impl Workbook {
    #[wasm_bindgen(constructor)]
    pub fn open(
        workbook: &str,
        relationships: &str,
        styles: &str,
        strings: &str,
    ) -> Result<Workbook, JsError> {
        let workbook = parse(workbook)?;
        let relationships = parse(relationships)?;
        let targets: HashMap<_, _> = relationships
            .descendants()
            .filter(|node| {
                node.has_tag_name("Relationship")
                    && node.attribute("TargetMode") != Some("External")
            })
            .filter_map(|node| Some((node.attribute("Id")?, node.attribute("Target")?)))
            .collect();
        let sheets = workbook
            .descendants()
            .filter(|node| {
                node.has_tag_name("sheet")
                    && !matches!(node.attribute("state"), Some("hidden" | "veryHidden"))
            })
            .take(256)
            .map(|node| {
                let target = RELATIONSHIP_NAMESPACES
                    .iter()
                    .find_map(|namespace| node.attribute((*namespace, "id")))
                    .and_then(|id| targets.get(id))
                    .map(|path| (*path).to_owned());
                (
                    node.attribute("name").unwrap_or_default().to_owned(),
                    target,
                )
            })
            .collect();
        let shared = if strings.is_empty() {
            Vec::new()
        } else {
            parse(strings)?
                .descendants()
                .filter(|node| node.has_tag_name("si"))
                .map(plain_text)
                .collect()
        };
        let styles = if styles.is_empty() {
            Vec::new()
        } else {
            cell_styles(&parse(styles)?)
        };
        Ok(Self {
            sheets,
            shared,
            styles,
        })
    }

    #[wasm_bindgen(js_name = "sheetFiles")]
    pub fn sheet_files(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.sheets)
            .map_err(|_| JsError::new("Could not read worksheet names."))
    }

    #[wasm_bindgen(js_name = "previewSheet")]
    pub fn preview_sheet(&self, source: &str) -> Result<String, JsError> {
        let grid = if source.is_empty() {
            Grid::default()
        } else {
            parse_grid(&parse(source)?, self)
        };
        serde_json::to_string(&Worksheet {
            grid,
            styles: &self.styles,
        })
        .map_err(|_| JsError::new("Could not read worksheet cells."))
    }
}

fn parse(source: &str) -> Result<Document<'_>, JsError> {
    Document::parse(source).map_err(|_| JsError::new("Unsupported document XML."))
}

fn child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|child| child.has_tag_name(name))
}

fn plain_text(node: Node<'_, '_>) -> String {
    node.descendants()
        .filter(|child| child.has_tag_name("t"))
        .filter_map(|node| node.text())
        .collect()
}

fn attribute_number<T: std::str::FromStr>(node: Node<'_, '_>, key: &str) -> Option<T> {
    node.attribute(key)?.parse().ok()
}

fn positive(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value > 0.0)
}

fn enabled(value: Option<&str>) -> bool {
    matches!(value, Some("1" | "true"))
}

fn color(node: Option<Node<'_, '_>>) -> Option<String> {
    let rgb = node?.attribute("rgb")?;
    (matches!(rgb.len(), 6 | 8) && rgb.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| format!("#{}", &rgb[rgb.len() - 6..]))
}

fn cell_styles(document: &Document<'_>) -> Vec<CellStyle> {
    let root = document.root_element();
    let group = |name: &str, entry: &str| -> Vec<_> {
        child(root, name)
            .into_iter()
            .flat_map(|node| node.children())
            .filter(|node| node.has_tag_name(entry))
            .collect()
    };
    let fonts = group("fonts", "font");
    let fills = group("fills", "fill");
    group("cellXfs", "xf")
        .into_iter()
        .take(4_096)
        .map(|style| {
            let font = fonts
                .get(attribute_number(style, "fontId").unwrap_or(0))
                .copied();
            let fill = fills
                .get(attribute_number(style, "fillId").unwrap_or(0))
                .copied();
            let alignment = child(style, "alignment");
            let flag = |name| {
                font.and_then(|font| child(font, name))
                    .is_some_and(|node| !matches!(node.attribute("val"), Some("0" | "false")))
            };
            let pattern = fill
                .and_then(|fill| child(fill, "patternFill"))
                .filter(|pattern| pattern.attribute("patternType") == Some("solid"));
            CellStyle {
                bold: flag("b"),
                italic: flag("i"),
                color: color(font.and_then(|font| child(font, "color"))),
                fill: color(pattern.and_then(|pattern| child(pattern, "fgColor"))),
                font_size: positive(
                    font.and_then(|font| child(font, "sz"))
                        .and_then(|size| attribute_number(size, "val")),
                )
                .filter(|size| *size <= 72.0)
                .map(|size| size * 4.0 / 3.0),
                align: alignment
                    .and_then(|node| node.attribute("horizontal"))
                    .filter(|value| matches!(*value, "left" | "center" | "right"))
                    .map(str::to_owned),
                wrap: enabled(alignment.and_then(|node| node.attribute("wrapText"))),
                format: attribute_number(style, "numFmtId").unwrap_or(0),
            }
        })
        .collect()
}

fn position(reference: &str) -> Option<(usize, usize)> {
    let prefix = reference
        .bytes()
        .take_while(|byte| byte.is_ascii_uppercase())
        .count();
    if !(1..=3).contains(&prefix) {
        return None;
    }
    let (letters, digits) = reference.split_at(prefix);
    if digits.len() > 7
        || digits.starts_with('0')
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let row = digits.parse::<usize>().ok()?.checked_sub(1)?;
    let column = letters.bytes().fold(0, |value, letter| {
        value * 26 + usize::from(letter - b'A' + 1)
    });
    Some((row, column - 1))
}

fn format_number(raw: &str, format: u32) -> String {
    let Some(number) = raw.parse::<f64>().ok().filter(|number| number.is_finite()) else {
        return raw.into();
    };
    let fixed = |value: f64, digits: usize| {
        if digits == 0 {
            format!("{:.0}", value.round())
        } else {
            format!("{value:.digits$}")
        }
    };
    match format {
        1 | 2 => fixed(number, if format == 1 { 0 } else { 2 }),
        3 | 4 => {
            let decimal = fixed(number.abs(), if format == 3 { 0 } else { 2 });
            let (whole, rest) = decimal.split_once('.').unwrap_or((&decimal, ""));
            let mut grouped = if number < 0.0 {
                "-".to_owned()
            } else {
                String::new()
            };
            for (index, digit) in whole.chars().enumerate() {
                if index != 0 && (whole.len() - index) % 3 == 0 {
                    grouped.push(',');
                }
                grouped.push(digit);
            }
            if !rest.is_empty() {
                grouped.push('.');
                grouped.push_str(rest);
            }
            grouped
        }
        9 | 10 => format!(
            "{}%",
            fixed(100.0 * number, if format == 9 { 0 } else { 2 })
        ),
        11 => {
            let scientific = format!("{number:.2e}");
            if let Some((mantissa, exponent)) = scientific.split_once('e') {
                format!(
                    "{mantissa}e{}{exponent}",
                    if exponent.starts_with('-') { "" } else { "+" }
                )
            } else {
                scientific
            }
        }
        _ => raw.into(),
    }
}

fn parse_grid(document: &Document<'_>, workbook: &Workbook) -> Grid {
    let mut grid = Grid::default();
    let format = document
        .descendants()
        .find(|node| node.has_tag_name("sheetFormatPr"));
    let row_height =
        positive(format.and_then(|node| attribute_number::<f64>(node, "defaultRowHeight")))
            .map_or(20.0, |height| (height * 4.0 / 3.0).clamp(12.0, 512.0));
    let width = positive(format.and_then(|node| attribute_number::<f64>(node, "defaultColWidth")))
        .map_or(64.0, |width| (width * 7.0).clamp(12.0, 768.0));
    let mut row_sizes = HashMap::new();
    let mut row_count = 0;
    let mut column_count = 0;
    let mut text_length = 0;
    let data = document
        .descendants()
        .find(|node| node.has_tag_name("sheetData"));
    let rows = data
        .into_iter()
        .flat_map(|node| node.children())
        .filter(|node| node.has_tag_name("row"));
    for (index, row) in rows.enumerate() {
        let row_index = attribute_number::<usize>(row, "r")
            .and_then(|index| index.checked_sub(1))
            .unwrap_or(index);
        if row_index >= MAX_ROWS || grid.cells.len() >= MAX_CELLS || text_length >= MAX_TEXT {
            grid.truncated = true;
            break;
        }
        let height = if enabled(row.attribute("hidden")) {
            0.0
        } else {
            positive(attribute_number(row, "ht"))
                .map_or(row_height, |height| (height * 4.0 / 3.0).min(512.0))
        };
        row_sizes.insert(row_index, height);
        for (column, cell) in row
            .children()
            .filter(|node| node.has_tag_name("c"))
            .enumerate()
        {
            if grid.cells.len() >= MAX_CELLS || text_length >= MAX_TEXT {
                grid.truncated = true;
                break;
            }
            let (row_index, column) = cell
                .attribute("r")
                .and_then(position)
                .unwrap_or((row_index, column));
            if row_index >= MAX_ROWS || column >= MAX_COLUMNS {
                grid.truncated = true;
                continue;
            }
            row_count = row_count.max(row_index + 1);
            column_count = column_count.max(column + 1);
            let style = attribute_number::<usize>(cell, "s")
                .or_else(|| attribute_number(row, "s"))
                .unwrap_or(0);
            let raw = child(cell, "v")
                .and_then(|node| node.text())
                .unwrap_or_default();
            let formula = child(cell, "f").and_then(|node| node.text());
            let kind = cell.attribute("t").unwrap_or_default();
            let numeric = matches!(kind, "" | "n") && !raw.is_empty();
            let value = match kind {
                "s" => raw
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| workbook.shared.get(index))
                    .cloned()
                    .unwrap_or_default(),
                "inlineStr" => plain_text(cell),
                "b" => {
                    if raw == "1" {
                        "TRUE".into()
                    } else {
                        "FALSE".into()
                    }
                }
                _ if numeric => format_number(
                    raw,
                    workbook.styles.get(style).map_or(0, |style| style.format),
                ),
                _ if raw.is_empty() => {
                    formula.map_or_else(String::new, |formula| format!("={formula}"))
                }
                _ => raw.into(),
            };
            if value.is_empty() && style == 0 {
                continue;
            }
            text_length += value.encode_utf16().count();
            if text_length > MAX_TEXT {
                grid.truncated = true;
                break;
            }
            grid.cells.push((row_index, column, value, style, numeric));
        }
    }
    for (index, merge) in document
        .descendants()
        .filter(|node| node.has_tag_name("mergeCell"))
        .enumerate()
    {
        if index >= MAX_MERGES {
            grid.truncated = true;
            break;
        }
        let Some((start, end)) = merge
            .attribute("ref")
            .and_then(|value| value.split_once(':'))
        else {
            continue;
        };
        let (Some((top, left)), Some((bottom, right))) = (position(start), position(end)) else {
            continue;
        };
        if bottom < top || right < left {
            continue;
        }
        if bottom >= MAX_ROWS || right >= MAX_COLUMNS {
            grid.truncated = true;
            continue;
        }
        row_count = row_count.max(bottom + 1);
        column_count = column_count.max(right + 1);
        grid.merges.push((top, left, bottom, right));
    }
    grid.rows = (0..row_count)
        .map(|row| row_sizes.get(&row).copied().unwrap_or(row_height))
        .collect();
    grid.columns = vec![width; column_count];
    for column in document
        .descendants()
        .filter(|node| node.has_tag_name("col"))
    {
        let Some(minimum) = attribute_number::<usize>(column, "min") else {
            continue;
        };
        let Some(maximum) = attribute_number::<usize>(column, "max") else {
            continue;
        };
        let start = minimum.saturating_sub(1);
        let end = maximum.min(column_count);
        if start >= end {
            continue;
        }
        let size = if enabled(column.attribute("hidden")) {
            0.0
        } else {
            positive(attribute_number(column, "width"))
                .map_or(width, |width| (width * 7.0).clamp(12.0, 768.0))
        };
        grid.columns[start..end].fill(size);
    }
    fit_cells(&mut grid, &workbook.styles);
    grid
}

fn text_width(text: &str, size: f64) -> f64 {
    let units: f64 = text
        .chars()
        .map(|character| match character {
            '\t' => 1.5,
            ' ' | 'i' | 'l' | 'I' | '.' | ',' | ':' | ';' | '!' | '|' | '\'' | '`' => 0.34,
            '\u{1f000}'..=char::MAX => 1.25,
            '\u{2e80}'..='\u{1efff}' => 1.0,
            'W' | 'M' | 'w' | 'm' | '@' | '%' | '&' => 0.9,
            _ => 0.65,
        })
        .sum();
    units * size
}

fn line_count(text: &str, font: f64, width: f64) -> f64 {
    static TOKENS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"[^\S\n]+|[\u{2e80}-\u{ffff}]|[^\s\u{2e80}-\u{ffff}]+")
            .expect("worksheet wrapping expression")
    });
    let mut lines = 0.0;
    for paragraph in text.split('\n') {
        lines += 1.0;
        let mut available = width;
        for token in TOKENS.find_iter(paragraph).map(|token| token.as_str()) {
            let size = text_width(token, font);
            if size > available {
                if available < width {
                    lines += 1.0;
                }
                available = width;
                if token.trim().is_empty() {
                    continue;
                }
                let extra = ((size / width).ceil() - 1.0).max(0.0);
                lines += extra;
                available -= size - extra * width;
            } else {
                available -= size;
            }
        }
    }
    lines
}

fn fit_cells(grid: &mut Grid, styles: &[CellStyle]) {
    let merged: HashMap<_, _> = grid
        .merges
        .iter()
        .map(|&(top, left, bottom, right)| ((top, left), (bottom, right)))
        .collect();
    let size = |style| {
        let style: Option<&CellStyle> = styles.get(style);
        let font = style.and_then(|style| style.font_size).unwrap_or(14.0);
        let measured = font
            * if style.is_some_and(|style| style.bold) {
                1.08
            } else {
                1.0
            };
        (font, measured)
    };
    for (row, column, text, style, _) in &grid.cells {
        if text.is_empty()
            || grid.rows[*row] == 0.0
            || grid.columns[*column] == 0.0
            || styles.get(*style).is_some_and(|style| style.wrap)
            || merged.contains_key(&(*row, *column))
        {
            continue;
        }
        let widest = text
            .split('\n')
            .map(|line| text_width(line, size(*style).1))
            .fold(0.0, f64::max);
        grid.columns[*column] = grid.columns[*column].max((widest + 16.0).ceil().min(420.0));
    }
    for (row, column, text, style, _) in &grid.cells {
        if text.is_empty() || grid.rows[*row] == 0.0 || grid.columns[*column] == 0.0 {
            continue;
        }
        let (bottom, right) = merged
            .get(&(*row, *column))
            .copied()
            .unwrap_or((*row, *column));
        let width = grid.columns[*column..=right].iter().sum::<f64>();
        let height = grid.rows[*row..=bottom].iter().sum::<f64>();
        let (font, measured) = size(*style);
        let lines = line_count(text, measured, (width - 12.0).max(1.0));
        let needed = (lines * font * 1.25 + if lines > 1.0 { 3.0 } else { 1.0 }).ceil();
        grid.rows[*row] += (needed - height).max(0.0);
    }
}
