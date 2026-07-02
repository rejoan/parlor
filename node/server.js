/**
 * Parlor (বাংলা সংস্করণ) — Node.js backend.
 *
 * Speaks the exact same WebSocket protocol as the original Python server
 * (src/server.py), so src/index.html works unchanged. Instead of on-device
 * models it uses:
 *
 *   - Google Gemini API (free tier) for speech + vision understanding
 *   - Microsoft Edge TTS (free, no key) for Bengali speech output
 *
 * Wire protocol (client → server): {audio?: wavBase64, image?: jpegBase64,
 * text?: string} or {type: "interrupt"}.
 * Server → client: {type:"text"|"audio_start"|"audio_chunk"|"audio_end", ...}
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the repo root (and cwd), wherever the server was started from
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config();

const PORT = Number(process.env.PORT || 8000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const TTS_VOICE = process.env.TTS_VOICE || "bn-BD-NabanitaNeural";
const MAX_HISTORY_TURNS = 20; // user+model message pairs kept as context

const SYSTEM_PROMPT = `তুমি "পার্লার" — একজন আন্তরিক, প্রাণবন্ত এআই সঙ্গী। ব্যবহারকারী মাইক্রোফোনে তোমার সঙ্গে কথা বলছেন, আর মাঝে মাঝে ক্যামেরায় তাঁদের চারপাশও দেখাচ্ছেন।

নিয়মগুলো মনে রেখো:
- সবসময় সহজ, প্রাঞ্জল, কথ্য বাংলায় উত্তর দেবে — যেন কাছের বন্ধুর সঙ্গে আড্ডা দিচ্ছ। বইয়ের ভাষার মতো আড়ষ্ট বা যান্ত্রিক অনুবাদ একেবারেই নয়।
- উত্তর ছোট রাখবে: ১ থেকে ৪টি ছোট বাক্য। তোমার কথা জোরে পড়ে শোনানো হবে, তাই ইমোজি, মার্কডাউন বা তালিকা ব্যবহার করবে না।
- ব্যবহারকারী অন্য কোনো ভাষায় কথা বললেও উত্তর বাংলাতেই দেবে।
- transcription ফিল্ডে ব্যবহারকারী ঠিক যা বলেছেন, যে ভাষায় বলেছেন, হুবহু তা-ই লিখবে।`;

const NO_KEY_MESSAGE =
  "দুঃখিত, সার্ভারে এখনো জেমিনি এপিআই কী বসানো হয়নি। " +
  "parlor ফোল্ডারের .env ফাইলে GEMINI_API_KEY যোগ করে সার্ভারটি আবার চালু করুন। " +
  "aistudio.google.com থেকে বিনামূল্যে কী পাওয়া যায়।";

const ERROR_MESSAGE = "দুঃখিত, একটা সমস্যা হয়ে গেল। একটু পরে আবার চেষ্টা করুন তো।";

// Sentence boundaries: Latin punctuation plus the Bengali danda (।)
const SENTENCE_SPLIT_RE = /(?<=[.!?।])\s+/u;

function splitSentences(text) {
  return text
    .trim()
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Gemini ──────────────────────────────────────────────────────────────────

async function callGemini(history) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: history,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          transcription: {
            type: "STRING",
            description: "Exact transcription of what the user said, in the language they spoke.",
          },
          response: {
            type: "STRING",
            description: "Conversational reply in natural spoken Bengali, 1-4 short sentences.",
          },
        },
        required: ["transcription", "response"],
      },
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini API ${res.status}: ${detail.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  try {
    const parsed = JSON.parse(text);
    return {
      transcription: (parsed.transcription || "").trim(),
      response: (parsed.response || "").trim(),
    };
  } catch {
    // Model ignored the schema — treat the raw text as the reply
    return { transcription: "", response: text.trim() };
  }
}

// ── Edge TTS ────────────────────────────────────────────────────────────────

// The free Edge endpoint only serves compressed audio (no raw PCM), so
// sentences go to the browser as MP3 chunks; the frontend decodes them with
// decodeAudioData (signalled by format: "mp3" on each chunk).
const MP3_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

class TtsClient {
  constructor(voice) {
    this.voice = voice;
    this.sampleRate = 24000;
    this._tts = null;
    this._queue = Promise.resolve();
  }

  /** Serialize synthesis calls; one Edge websocket at a time per client. */
  synthesize(text) {
    const run = this._queue.then(() => this._synthesize(text));
    // Keep the chain alive even after a failure
    this._queue = run.catch(() => {});
    return run;
  }

  async _synthesize(text, retried = false) {
    try {
      if (!this._tts) {
        this._tts = new MsEdgeTTS();
        await this._tts.setMetadata(this.voice, MP3_FORMAT);
      }
      const { audioStream } = await this._tts.toStream(text);
      return await this._collect(audioStream);
    } catch (err) {
      this._tts = null; // stale Edge websocket — reconnect on retry
      if (!retried) return this._synthesize(text, true);
      throw err;
    }
  }

  _collect(stream) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const timer = setTimeout(() => reject(new Error("Edge TTS timeout")), 20000);
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      stream.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
}

// ── HTTP server (serves the shared frontend) ────────────────────────────────

const INDEX_PATH = path.join(__dirname, "..", "src", "index.html");

function renderIndex() {
  // The frontend is shared with the Python server; swap the on-device labels
  // for what this backend actually runs on.
  return readFileSync(INDEX_PATH, "utf8")
    .replace(">Gemma 4 E2B<", `>${GEMINI_MODEL}<`)
    .replace(/অন-ডিভাইস/g, "ক্লাউড এপিআই");
}

const httpServer = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderIndex());
  } else {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

// ── WebSocket endpoint ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("Client connected");
  const history = []; // Gemini `contents` array for this conversation
  const tts = new TtsClient(TTS_VOICE);
  let interrupted = false;
  let processing = Promise.resolve(); // serialize turns per connection

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  async function handleTurn(msg) {
    interrupted = false;

    const parts = [];
    if (msg.audio) parts.push({ inlineData: { mimeType: "audio/wav", data: msg.audio } });
    if (msg.image) parts.push({ inlineData: { mimeType: "image/jpeg", data: msg.image } });

    if (msg.audio && msg.image) {
      parts.push({ text: "ব্যবহারকারী এইমাত্র কথা বললেন (অডিও) এবং ক্যামেরায় কিছু দেখাচ্ছেন (ছবি)। তাঁর কথার জবাব দাও; প্রাসঙ্গিক হলে যা দেখছ তার উল্লেখ করো।" });
    } else if (msg.audio) {
      parts.push({ text: "ব্যবহারকারী এইমাত্র কথা বললেন। তাঁর কথার জবাব দাও।" });
    } else if (msg.image) {
      parts.push({ text: "ব্যবহারকারী ক্যামেরায় কিছু দেখাচ্ছেন। যা দেখছ, বর্ণনা করো।" });
    } else {
      parts.push({ text: msg.text || "হ্যালো!" });
    }

    // LLM inference
    const t0 = Date.now();
    let transcription = "";
    let textResponse;

    if (!GEMINI_API_KEY) {
      textResponse = NO_KEY_MESSAGE;
      console.log("No GEMINI_API_KEY set — sending setup notice");
    } else {
      history.push({ role: "user", parts });
      try {
        const result = await callGemini(history);
        transcription = result.transcription;
        textResponse = result.response || ERROR_MESSAGE;
        // Replace the heavy audio/image blobs with the transcription so the
        // rolling context stays small.
        history[history.length - 1] = {
          role: "user",
          parts: [{ text: transcription || msg.text || "(অস্পষ্ট অডিও)" }],
        };
        history.push({ role: "model", parts: [{ text: textResponse }] });
        while (history.length > MAX_HISTORY_TURNS * 2) history.shift();
      } catch (err) {
        console.error("LLM error:", err.message);
        history.pop(); // drop the failed turn
        textResponse = ERROR_MESSAGE;
      }
    }

    const llmTime = (Date.now() - t0) / 1000;
    console.log(`LLM (${llmTime.toFixed(2)}s) heard: ${JSON.stringify(transcription)} → ${textResponse}`);

    if (interrupted) {
      console.log("Interrupted after LLM, skipping response");
      return;
    }

    const reply = { type: "text", text: textResponse, llm_time: Math.round(llmTime * 100) / 100 };
    if (transcription) reply.transcription = transcription;
    send(reply);

    // Streaming TTS: sentence by sentence, same as the Python server
    let sentences = splitSentences(textResponse);
    if (!sentences.length) sentences = [textResponse];

    const ttsStart = Date.now();
    send({
      type: "audio_start",
      sample_rate: tts.sampleRate,
      sentence_count: sentences.length,
    });

    for (let i = 0; i < sentences.length; i++) {
      if (interrupted) {
        console.log(`Interrupted during TTS (sentence ${i + 1}/${sentences.length})`);
        break;
      }
      let audio;
      try {
        audio = await tts.synthesize(sentences[i]);
      } catch (err) {
        console.error("TTS error:", err.message);
        break;
      }
      if (interrupted || !audio.length) break;

      send({ type: "audio_chunk", audio: audio.toString("base64"), index: i, format: "mp3" });
    }

    const ttsTime = (Date.now() - ttsStart) / 1000;
    console.log(`TTS (${ttsTime.toFixed(2)}s): ${sentences.length} sentences`);

    if (!interrupted) {
      send({ type: "audio_end", tts_time: Math.round(ttsTime * 100) / 100 });
    }
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "interrupt") {
      interrupted = true;
      console.log("Client interrupted");
      return;
    }
    processing = processing.then(() =>
      handleTurn(msg).catch((err) => console.error("Turn failed:", err))
    );
  });

  ws.on("close", () => console.log("Client disconnected"));
});

httpServer.listen(PORT, () => {
  console.log(`Parlor (বাংলা) চালু হয়েছে → http://localhost:${PORT}`);
  console.log(`  LLM: ${GEMINI_API_KEY ? GEMINI_MODEL + " (Gemini API)" : "কোনো GEMINI_API_KEY নেই — সেটআপ নোটিস পাঠানো হবে"}`);
  console.log(`  TTS: Microsoft Edge TTS, কণ্ঠ: ${TTS_VOICE}`);
});
