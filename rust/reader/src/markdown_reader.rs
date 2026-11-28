use markdown::{ParseOptions, mdast::Node, to_mdast};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Default, Serialize)]
struct Structure<'a> {
    tables: Vec<(usize, usize)>,
    references: Vec<Reference<'a>>,
}

#[derive(Serialize)]
struct Reference<'a> {
    label: &'a str,
    destination: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
}

#[wasm_bindgen(js_name = "markdownStructure")]
pub fn markdown_structure(source: &str) -> Result<String, JsError> {
    let tree = to_mdast(source, &ParseOptions::gfm())
        .map_err(|_| JsError::new("Could not parse Markdown."))?;
    let mut result = Structure::default();
    if let Node::Root(root) = &tree {
        for child in &root.children {
            if let Node::Table(table) = child {
                if let Some(position) = &table.position {
                    result
                        .tables
                        .push((position.start.line - 1, position.end.line));
                }
            }
        }
    }
    let mut pending = vec![&tree];
    while let Some(node) = pending.pop() {
        if let Node::Definition(definition) = node {
            result.references.push(Reference {
                label: &definition.identifier,
                destination: &definition.url,
                title: definition.title.as_deref(),
            });
        } else if let Some(children) = node.children() {
            pending.extend(children.iter().rev());
        }
    }
    serde_json::to_string(&result).map_err(|_| JsError::new("Could not read Markdown blocks."))
}

#[wasm_bindgen(js_name = "markdownHeading")]
pub fn markdown_heading(source: &str) -> String {
    let title = format!("# {source}");
    let Ok(Node::Root(root)) = to_mdast(&title, &ParseOptions::gfm()) else {
        return String::new();
    };
    root.children
        .first()
        .map_or_else(String::new, |node| node.to_string().trim().to_owned())
}
