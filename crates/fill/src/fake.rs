//! A writer with no windows, for the ladder and undo tests.

use crate::write::{Need, Writer};
use crate::FillError;

#[derive(Debug, Clone)]
pub struct Behaviour {
    pub value: String,
    /// A direct set takes. A React box that only listens to input events does not.
    pub sticks: bool,
    pub pastes: bool,
    pub types: bool,
    pub readable: bool,
    pub gone: bool,
    /// A direct set leaves something other than what was set.
    pub mangles: bool,
    /// The box formats what it is given.
    pub strips_spaces: bool,
    pub items: Vec<String>,
    /// Another window came to the front just before this box.
    pub elsewhere: bool,
    /// A picker the page built: it takes the text, then empties itself once another box is written.
    pub empties_when_left: bool,
}

impl Default for Behaviour {
    fn default() -> Self {
        Self {
            value: String::new(),
            sticks: true,
            pastes: true,
            types: true,
            readable: true,
            gone: false,
            mangles: false,
            strips_spaces: false,
            items: Vec::new(),
            elsewhere: false,
            empties_when_left: false,
        }
    }
}

#[derive(Debug)]
pub struct FakeBox {
    pub value: String,
    pub behaviour: Behaviour,
    /// What Ctrl+Z goes back to.
    history: Vec<String>,
}

impl FakeBox {
    fn change(&mut self, value: String) {
        self.history.push(std::mem::replace(&mut self.value, value));
    }
}

#[derive(Debug)]
pub struct Fake {
    pub boxes: Vec<FakeBox>,
    pub focus: Option<u32>,
    /// Every write, focus and key, in order. Checks and reads are not listed.
    pub calls: Vec<String>,
    /// The user clicks elsewhere while a direct set runs.
    pub steal_focus_on_set: bool,
}

impl Fake {
    pub fn new(boxes: Vec<Behaviour>) -> Self {
        let boxes = boxes
            .into_iter()
            .map(|behaviour| FakeBox { value: behaviour.value.clone(), behaviour, history: Vec::new() })
            .collect();
        Self { boxes, focus: None, calls: Vec::new(), steal_focus_on_set: false }
    }

    pub fn one(behaviour: Behaviour) -> Self {
        Self::new(vec![behaviour])
    }

    fn at(&mut self, id: u32) -> &mut FakeBox {
        &mut self.boxes[id as usize]
    }

    /// Writing in one box leaves the others, and a picker the page built empties itself then.
    fn leave_others(&mut self, id: u32) {
        for (at, other) in self.boxes.iter_mut().enumerate() {
            if at as u32 != id && other.behaviour.empties_when_left {
                other.value.clear();
            }
        }
    }

    fn focused(&mut self) -> &mut FakeBox {
        let id = self.focus.expect("keys need a focused box");
        self.at(id)
    }
}

impl Writer for Fake {
    fn check(&mut self, id: u32, need: Need) -> Result<(), FillError> {
        match self.boxes.get(id as usize) {
            None => Err(FillError::Gone),
            Some(found) if found.behaviour.elsewhere => Err(FillError::WindowChanged),
            Some(found) if found.behaviour.gone => Err(FillError::Gone),
            Some(_) if need == Need::Focus && self.focus != Some(id) => Err(FillError::Moved),
            Some(_) => Ok(()),
        }
    }

    fn value(&mut self, id: u32) -> Result<String, FillError> {
        let found = self.at(id);
        if found.behaviour.readable {
            Ok(found.value.clone())
        } else {
            Err(FillError::Platform("This box cannot be read.".into()))
        }
    }

    fn set_value(&mut self, id: u32, text: &str) -> Result<(), FillError> {
        self.calls.push(format!("set {id}"));
        self.leave_others(id);
        if self.steal_focus_on_set {
            self.focus = None;
        }
        let found = self.at(id);
        if found.behaviour.mangles {
            found.change(format!("{text}?"));
        } else if found.behaviour.sticks {
            let value = if found.behaviour.strips_spaces { text.replace(' ', "") } else { text.to_string() };
            found.change(value);
        }
        Ok(())
    }

    fn set_checked(&mut self, id: u32, on: bool) -> Result<(), FillError> {
        self.calls.push(format!("tick {id}"));
        self.at(id).change(on.to_string());
        Ok(())
    }

    fn choose(&mut self, id: u32, item: &str) -> Result<(), FillError> {
        self.calls.push(format!("choose {id}"));
        let found = self.at(id);
        if !found.behaviour.items.iter().any(|known| known == item) {
            return Err(FillError::NeedsYou("That choice is not in the list.".into()));
        }
        found.change(item.to_string());
        Ok(())
    }

    fn focus(&mut self, id: u32) -> Result<(), FillError> {
        self.calls.push(format!("focus {id}"));
        self.focus = Some(id);
        Ok(())
    }

    fn paste(&mut self, id: u32, text: &str, replace: bool) -> Result<(), FillError> {
        self.calls.push(format!("paste {id} {}", if replace { "replace" } else { "at cursor" }));
        self.leave_others(id);
        let found = self.at(id);
        if found.behaviour.pastes {
            let value = if replace { text.to_string() } else { format!("{}{text}", found.value) };
            found.change(value);
        }
        Ok(())
    }

    fn type_text(&mut self, id: u32, text: &str, replace: bool) -> Result<(), FillError> {
        assert!(!text.chars().any(char::is_control), "control characters are never typed");
        assert_eq!(self.focus, Some(id), "keys go only to the focused box");
        self.calls.push(format!("type {}", if replace { "replace" } else { "at cursor" }));
        let found = self.focused();
        if found.behaviour.types {
            let value = if replace { text.to_string() } else { format!("{}{text}", found.value) };
            found.change(value);
        }
        Ok(())
    }

    fn undo_keys(&mut self, id: u32) -> Result<(), FillError> {
        assert_eq!(self.focus, Some(id), "keys go only to the focused box");
        self.calls.push("ctrl z".into());
        let found = self.focused();
        if let Some(previous) = found.history.pop() {
            found.value = previous;
        }
        Ok(())
    }

    fn wait(&mut self, _ms: u64) {}
}
