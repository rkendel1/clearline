//! Clearline visual identity (ported from the former dashboard's design tokens):
//! a dark navigation rail, warm paper background, one accent, and status colours
//! reserved for state and always paired with an icon and a word.

use gpui::{rgb, App, Global, Hsla, Window};
use gpui_component::{Theme, ThemeMode};

#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub paper: Hsla,
    pub surface: Hsla,
    pub ink: Hsla,
    pub ink2: Hsla,
    pub muted: Hsla,
    pub rule: Hsla,
    pub rule_strong: Hsla,
    pub accent: Hsla,
    pub accent_ink: Hsla,
    pub rail: Hsla,
    pub rail_ink: Hsla,
    pub rail_muted: Hsla,
    pub rail_active: Hsla,
    pub good: Hsla,
    pub good_ink: Hsla,
    pub good_bg: Hsla,
    pub warn: Hsla,
    pub warn_ink: Hsla,
    pub warn_bg: Hsla,
    pub bad: Hsla,
    pub bad_ink: Hsla,
    pub bad_bg: Hsla,
    pub idle_bg: Hsla,
    pub series1: Hsla,
    pub series2: Hsla,
    pub code_bg: Hsla,
}

impl Global for Palette {}

fn c(hex: u32) -> Hsla { rgb(hex).into() }

impl Palette {
    pub fn light() -> Self {
        Palette {
            paper: c(0xf3f5f2), surface: c(0xffffff), ink: c(0x17222d), ink2: c(0x4a5662), muted: c(0x66717b), rule: c(0xd6dbd4),
            rule_strong: c(0xb9c0b7), accent: c(0x1f5f8b), accent_ink: c(0xffffff), rail: c(0x17222d), rail_ink: c(0xe7ebe6), rail_muted: c(0xa7b1ba),
            rail_active: c(0x26323d), good: c(0x0ca30c), good_ink: c(0x0b6b0b), good_bg: c(0xe7f4e5), warn: c(0xfab219), warn_ink: c(0x7a5300),
            warn_bg: c(0xfdf3dc), bad: c(0xd03b3b), bad_ink: c(0xa12424), bad_bg: c(0xfbe9e7), idle_bg: c(0xeceee9), series1: c(0x2a78d6),
            series2: c(0xeb6834), code_bg: c(0xf7f8f6),
        }
    }
    pub fn dark() -> Self {
        Palette {
            paper: c(0x12181e), surface: c(0x1a2229), ink: c(0xe8ece9), ink2: c(0xc4cbc5), muted: c(0x98a2ab), rule: c(0x2d3740),
            rule_strong: c(0x43505b), accent: c(0x6aa9d8), accent_ink: c(0x0d1820), rail: c(0x0c1116), rail_ink: c(0xe8ece9), rail_muted: c(0x8d98a2),
            rail_active: c(0x1b242c), good: c(0x0ca30c), good_ink: c(0x6fd46f), good_bg: c(0x16301a), warn: c(0xfab219), warn_ink: c(0xf6c45a),
            warn_bg: c(0x342a12), bad: c(0xd03b3b), bad_ink: c(0xf08a8a), bad_bg: c(0x3a1c1c), idle_bg: c(0x252e36), series1: c(0x3987e5),
            series2: c(0xd95926), code_bg: c(0x151c22),
        }
    }
}

/// Apply the palette to the application and to the component library's theme.
pub fn apply(dark: bool, window: Option<&mut Window>, cx: &mut App) {
    let p = if dark { Palette::dark() } else { Palette::light() };
    Theme::change(if dark { ThemeMode::Dark } else { ThemeMode::Light }, window, cx);
    let t = Theme::global_mut(cx);
    t.font_family = "Inter".into();
    t.mono_font_family = "DejaVu Sans Mono".into();
    let k = &mut t.colors;
    k.background = p.surface;
    k.foreground = p.ink;
    k.border = p.rule;
    k.input = p.rule_strong;
    k.ring = p.accent;
    k.primary = p.accent;
    k.primary_hover = p.accent.opacity(0.88);
    k.primary_active = p.accent.opacity(0.8);
    k.primary_foreground = p.accent_ink;
    k.muted = p.idle_bg;
    k.muted_foreground = p.muted;
    k.secondary = p.idle_bg;
    k.secondary_hover = p.rule;
    k.secondary_foreground = p.ink;
    k.table = p.surface;
    k.table_head = p.paper;
    k.table_head_foreground = p.ink2;
    k.table_even = p.paper.opacity(0.5);
    k.table_hover = p.idle_bg;
    k.table_active = p.accent.opacity(0.12);
    k.table_active_border = p.accent;
    k.table_row_border = p.rule;
    k.danger = p.bad;
    k.success = p.good;
    k.warning = p.warn;
    k.popover = p.surface;
    k.popover_foreground = p.ink;
    k.selection = p.accent.opacity(0.25);
    k.caret = p.ink;
    k.link = p.accent;
    cx.set_global(p);
}
