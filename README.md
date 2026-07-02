# Parlor · পার্লার

On-device, real-time multimodal AI. Have natural voice and vision conversations with an AI that runs entirely on your machine.

Parlor uses [Gemma 4 E2B](https://huggingface.co/google/gemma-4-E2B-it) for understanding speech and vision, and [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) for text-to-speech. You talk, show your camera, and it talks back, all locally.

**This fork is localized for Bengali (বাংলা):** the UI, the AI's conversation language, and the voice output are all Bengali. It ships with two interchangeable backends — the original on-device Python server, and a new [Node.js backend](#bengali-port-nodejs-backend) that runs anywhere (including Windows) using free cloud APIs. See [Bengali port](#bengali-port-nodejs-backend) below.

https://github.com/user-attachments/assets/cb0ffb2e-f84f-48e7-872c-c5f7b5c6d51f

> **Research preview.** This is an early experiment. Expect rough edges and bugs.

# Why?

I'm [self-hosting a totally free voice AI](https://www.fikrikarim.com/bule-ai-initial-release/) on my home server to help people learn speaking English. It has hundreds of monthly active users, and I've been thinking about how to keep it free while making it sustainable.

The obvious answer: run everything on-device, eliminating any server cost. Six months ago I needed an RTX 5090 to run just the voice models in real-time.

Google just released a super capable small model that I can run on my M3 Pro in real-time, with vision too! Sure you can't do agentic coding with this, but it is a game-changer for people learning a new language. Imagine a few years from now that people can run this locally on their phones. They can point their camera at objects and talk about them. And this model is multi-lingual, so people can always fallback to their native language if they want. This is essentially what OpenAI demoed a few years ago.

## How it works

```
Browser (mic + camera)
    │
    │  WebSocket (audio PCM + JPEG frames)
    ▼
FastAPI server
    ├── Gemma 4 E2B via LiteRT-LM (GPU)  →  understands speech + vision
    └── Kokoro TTS (MLX on Mac, ONNX on Linux)  →  speaks back
    │
    │  WebSocket (streamed audio chunks)
    ▼
Browser (playback + transcript)
```

- **Voice Activity Detection** in the browser ([Silero VAD](https://github.com/ricky0123/vad)). Hands-free, no push-to-talk.
- **Barge-in.** Interrupt the AI mid-sentence by speaking.
- **Sentence-level TTS streaming.** Audio starts playing before the full response is generated.

## Requirements

- Python 3.12+
- macOS with Apple Silicon, or Linux with a supported GPU
- ~3 GB free RAM for the model

## Quick start

```bash
git clone https://github.com/fikrikarim/parlor.git
cd parlor

# Install uv if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh

cd src
uv sync
uv run server.py
```

Open [http://localhost:8000](http://localhost:8000), grant camera and microphone access, and start talking.

Models are downloaded automatically on first run (~2.6 GB for Gemma 4 E2B, plus TTS models).

> **Note on Bengali:** the Python backend now prompts Gemma to converse in Bengali, but its Kokoro TTS has no Bengali voice — spoken output quality will be poor. For a fully Bengali experience use the Node.js backend below.

## Bengali port (Node.js backend)

`node/server.js` speaks the exact same WebSocket protocol as the Python server and serves the same frontend, but swaps the on-device models for free hosted services, so it runs on any OS with Node 18+ and no GPU:

- **LLM (speech + vision):** [Gemini API](https://ai.google.dev/) free tier — a single multimodal call handles audio transcription, image understanding, and the Bengali reply.
- **TTS:** Microsoft Edge's public text-to-speech (via [msedge-tts](https://www.npmjs.com/package/msedge-tts)) with the Bengali voice `bn-BD-NabanitaNeural`. Free, no API key.

```bash
cd node
npm install

# Get a free key at https://aistudio.google.com/apikey
echo "GEMINI_API_KEY=your-key-here" > ../.env

npm start
```

Open [http://localhost:8000](http://localhost:8000). Without a key the server still runs — the assistant will tell you (in Bengali, out loud) how to finish setup.

## Configuration

| Variable         | Default                        | Used by | Description                                    |
| ---------------- | ------------------------------ | ------- | ---------------------------------------------- |
| `GEMINI_API_KEY` | —                              | Node    | Gemini API key (free tier works)               |
| `GEMINI_MODEL`   | `gemini-2.5-flash`             | Node    | Gemini model name                              |
| `TTS_VOICE`      | `bn-BD-NabanitaNeural`         | Node    | Edge TTS voice (`bn-BD-*` / `bn-IN-*`)         |
| `MODEL_PATH`     | auto-download from HuggingFace | Python  | Path to a local `gemma-4-E2B-it.litertlm` file |
| `PORT`           | `8000`                         | both    | Server port                                    |

## Performance (Apple M3 Pro)

| Stage                            | Time          |
| -------------------------------- | ------------- |
| Speech + vision understanding    | ~1.8-2.2s     |
| Response generation (~25 tokens) | ~0.3s         |
| Text-to-speech (1-3 sentences)   | ~0.3-0.7s     |
| **Total end-to-end**             | **~2.5-3.0s** |

Decode speed: ~83 tokens/sec on GPU (Apple M3 Pro).

## Project structure

```
src/
├── server.py              # FastAPI WebSocket server + Gemma 4 inference (on-device)
├── tts.py                 # Platform-aware TTS (MLX on Mac, ONNX on Linux)
├── index.html             # Frontend UI in Bengali (VAD, camera, audio playback) — shared by both backends
├── pyproject.toml         # Dependencies
└── benchmarks/
    ├── bench.py           # End-to-end WebSocket benchmark
    └── benchmark_tts.py   # TTS backend comparison
node/
├── server.js              # Node.js backend: Gemini API + Edge TTS (Bengali voice)
└── package.json           # Dependencies (ws, msedge-tts, dotenv)
```

## Acknowledgments

- [Gemma 4](https://ai.google.dev/gemma) by Google DeepMind
- [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) by Google AI Edge
- [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) TTS by Hexgrad
- [Silero VAD](https://github.com/snakers4/silero-vad) for browser voice activity detection

## License

[Apache 2.0](LICENSE)
