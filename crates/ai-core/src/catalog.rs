//! Every provider the app ships with. Adding one that speaks a known protocol
//! is a new row here and nothing else.

use serde::Serialize;

use crate::Capabilities;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Cloud,
    Local,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    OpenAi,
    Anthropic,
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderDef {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: Kind,
    pub protocol: Protocol,
    pub base_url: &'static str,
    pub needs_key: bool,
    pub capabilities: Capabilities,
}

const FULL: Capabilities = Capabilities { streaming: true, tools: true, vision: true, model_discovery: true, usage: true };
const TEXT: Capabilities = Capabilities { vision: false, ..FULL };

const fn cloud(id: &'static str, name: &'static str, base_url: &'static str, capabilities: Capabilities) -> ProviderDef {
    ProviderDef { id, name, kind: Kind::Cloud, protocol: Protocol::OpenAi, base_url, needs_key: true, capabilities }
}

const fn local(id: &'static str, name: &'static str, base_url: &'static str) -> ProviderDef {
    ProviderDef { id, name, kind: Kind::Local, protocol: Protocol::OpenAi, base_url, needs_key: false, capabilities: TEXT }
}

static CATALOG: [ProviderDef; 15] = [
    ProviderDef {
        id: "anthropic",
        name: "Anthropic",
        kind: Kind::Cloud,
        protocol: Protocol::Anthropic,
        base_url: "https://api.anthropic.com",
        needs_key: true,
        capabilities: FULL,
    },
    cloud("openai", "OpenAI", "https://api.openai.com/v1", FULL),
    cloud("gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", FULL),
    cloud("xai", "xAI", "https://api.x.ai/v1", FULL),
    cloud("deepseek", "DeepSeek", "https://api.deepseek.com/v1", TEXT),
    cloud("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", FULL),
    cloud("groq", "Groq", "https://api.groq.com/openai/v1", TEXT),
    cloud("together", "Together AI", "https://api.together.xyz/v1", TEXT),
    cloud("mistral", "Mistral", "https://api.mistral.ai/v1", TEXT),
    local("ollama", "Ollama", "http://localhost:11434/v1"),
    local("lmstudio", "LM Studio", "http://localhost:1234/v1"),
    local("llamacpp", "llama.cpp", "http://localhost:8080/v1"),
    local("vllm", "vLLM", "http://localhost:8000/v1"),
    local("jan", "Jan", "http://localhost:1337/v1"),
    ProviderDef {
        id: "custom",
        name: "Custom endpoint",
        kind: Kind::Custom,
        protocol: Protocol::OpenAi,
        base_url: "",
        needs_key: false,
        capabilities: TEXT,
    },
];

pub fn catalog() -> &'static [ProviderDef] {
    &CATALOG
}

pub fn find(id: &str) -> Option<&'static ProviderDef> {
    CATALOG.iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<_> = catalog().iter().map(|p| p.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), catalog().len());
    }

    #[test]
    fn local_providers_stay_on_this_machine_and_need_no_key() {
        for p in catalog().iter().filter(|p| p.kind == Kind::Local) {
            assert!(crate::is_loopback(p.base_url), "{}", p.id);
            assert!(!p.needs_key, "{}", p.id);
        }
    }

    #[test]
    fn cloud_providers_use_tls_and_need_a_key() {
        for p in catalog().iter().filter(|p| p.kind == Kind::Cloud) {
            assert!(p.base_url.starts_with("https://"), "{}", p.id);
            assert!(p.needs_key, "{}", p.id);
        }
    }
}
