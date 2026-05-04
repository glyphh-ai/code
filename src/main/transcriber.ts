/**
 * Transcriber — speech-to-text via server-proxied Whisper.
 *
 * Accepts raw 16kHz mono Float32Array audio from the renderer,
 * encodes to WAV, and sends to the yo-server transcription proxy.
 */

import { AUTH_SERVER, getAuthToken } from "./auth";

export class Transcriber {
  async transcribe(audio: Float32Array): Promise<string> {
    const token = getAuthToken();
    if (!token) throw new Error("Not authenticated — sign in to use voice input");

    const wav = encodeWav(audio, 16000);

    const res = await fetch(`${AUTH_SERVER}/api/llm/transcribe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "audio/wav",
      },
      body: wav,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Transcription ${res.status}: ${body}`);
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
