// The engine version here and the structs in `local.rs` must change together.
// Kokoro and Piper need espeak-ng to read plain text, which v2.0.0 removed, so 1.13.8 is the last
// engine that can speak with these packs. Going past it needs a lexicon or a phonemizer as well.
pub const PACKS: [Pack; 5] = [
    Pack {
        id: "engine",
        name: "Speech engine",
        bytes: 8_032_957,
        path: "v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-lib.tar.bz2",
        sha256: "b8eedf41bd6d3779218887b48367bb7a3ece5aaa7667f01f69ee823a12b0a9e7",
    },
    Pack {
        id: "hearing",
        name: "Hearing",
        bytes: 57_267_600,
        path: "asr-models/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2",
        sha256: "c8676e5ff9ac2a85296e53ee0fd4d5fb1db6770e7a7647166eeafe349ade6834",
    },
    Pack {
        id: "kokoro",
        name: "Kokoro",
        bytes: 319_625_534,
        path: "tts-models/kokoro-en-v0_19.tar.bz2",
        sha256: "912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7",
    },
    Pack {
        id: "piper-amy",
        name: "Piper, Amy",
        bytes: 21_099_246,
        path: "tts-models/vits-piper-en_US-amy-low-int8.tar.bz2",
        sha256: "93070ac9fadf512e56c46bdd0c5d2ce96b424fdc4e683d560167410bd2c4df7d",
    },
    Pack {
        id: "piper-alan",
        name: "Piper, Alan",
        bytes: 21_289_969,
        path: "tts-models/vits-piper-en_GB-alan-low-int8.tar.bz2",
        sha256: "6a3d39a4e9698184a90e16f251d01b79236a302d50d0955bcf461705a836f1d2",
    },
];
