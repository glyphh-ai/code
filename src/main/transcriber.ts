/**
 * Transcriber — speech-to-text via OpenAI Whisper API.
 *
 * Accepts raw 16kHz mono Float32Array audio from the renderer,
 * encodes to WAV, and sends to OpenAI's transcription endpoint.
 * Requires the user to provide their own OpenAI API key.
 */

import { getPreference } from "./preferences";

const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";

export class Transcriber {
  /** Transcribe raw 16kHz mono Float32Array audio via OpenAI Whisper. */
  async transcribe(audio: Float32Array): Promise<string> {
    const apiKey = getPreference<string>("voiceApiKey", "");
    if (!apiKey) throw new Error("No OpenAI key configured for voice input");

    // Encode Float32 PCM → 16-bit WAV
    const wav = encodeWav(audio, 16000);

    // Build multipart form data
    const blob = new Blob([wav], { type: "audio/wav" });
    const form = new FormData();
    form.append("file", blob, "voice.wav");
    form.append("model", "whisper-1");
    form.append("language", "en");

    const res = await fetch(WHISPER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Whisper API ${res.status}: ${body}`);
    }

    const data: any = await res.json();
    return (data.text ?? "").trim();
  }
}

/** Encode Float32 PCM samples to a 16-bit WAV buffer. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);           // chunk size
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);    // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);            // block align
  view.setUint16(34, 16, true);           // bits per sample

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, numSamples * 2, true);

  // Convert float32 [-1,1] to int16
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return buffer;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
