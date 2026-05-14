// voice-ui.ts — Voice recording system extracted from renderer.ts

// -- Voice sounds (synthesized tones, no files needed) --

function playTone(freq: number, durationMs: number, volume = 0.15) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.value = volume;
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000);
  osc.onended = () => ctx.close();
}

function playRecordStart() { playTone(880, 120); setTimeout(() => playTone(1320, 100), 130); }
function playRecordStop() { playTone(1320, 120); setTimeout(() => playTone(880, 100), 130); }

// -- Voice input (getUserMedia + silence detection + Whisper via IPC) --

export interface VoiceDeps {
  getInputEl: () => HTMLTextAreaElement;
  onTranscribed: (text: string) => void;
}

export function initVoice(deps: VoiceDeps): void {
  const yoPanelMicBtn = document.getElementById("yo-panel-mic") as HTMLButtonElement | null;
  if (!yoPanelMicBtn) return;

  // Hide mic button by default — shown when voiceEnabled pref is true
  yoPanelMicBtn.style.display = "none";
  window.yo.getPreference("voiceEnabled", false).then((v) => {
    yoPanelMicBtn!.style.display = v ? "" : "none";
  });

  let recording = false;
  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let micStream: MediaStream | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceCheckInterval: ReturnType<typeof setInterval> | null = null;

  const SILENCE_THRESHOLD = 0.01;  // RMS below this = silence
  const SILENCE_TIMEOUT = 1500;    // ms of silence before auto-stop

  function stopRecording() {
    if (silenceCheckInterval) { clearInterval(silenceCheckInterval); silenceCheckInterval = null; }
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    mediaRecorder?.stop();
  }

  yoPanelMicBtn.addEventListener("click", async () => {
    // Check yoThinking via the input element's disabled state as a proxy
    const inputEl = deps.getInputEl();
    if (inputEl.disabled) return;

    if (recording) {
      stopRecording();
      return;
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn("Mic access denied:", err);
      return;
    }

    recording = true;
    audioChunks = [];
    yoPanelMicBtn!.classList.add("listening");
    playRecordStart();

    // Set up silence detection via AnalyserNode
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(micStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let speaking = false;

    silenceCheckInterval = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((sum, v) => sum + v * v, 0) / buf.length);

      if (rms > SILENCE_THRESHOLD) {
        speaking = true;
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      } else if (speaking && !silenceTimer) {
        // Started being silent after speaking — start countdown
        silenceTimer = setTimeout(() => {
          audioCtx.close();
          stopRecording();
        }, SILENCE_TIMEOUT);
      }
    }, 100);

    mediaRecorder = new MediaRecorder(micStream, { mimeType: "audio/webm" });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      recording = false;
      yoPanelMicBtn!.classList.remove("listening");
      playRecordStop();
      if (silenceCheckInterval) { clearInterval(silenceCheckInterval); silenceCheckInterval = null; }
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      // Release mic
      micStream?.getTracks().forEach((t) => t.stop());
      micStream = null;

      if (audioChunks.length === 0) return;

      const blob = new Blob(audioChunks, { type: "audio/webm" });
      audioChunks = [];

      // Decode to raw 16kHz mono Float32 for Whisper
      const arrayBuf = await blob.arrayBuffer();
      const decodeCtx = new AudioContext({ sampleRate: 16000 });
      let decoded: AudioBuffer;
      try {
        decoded = await decodeCtx.decodeAudioData(arrayBuf);
      } catch {
        console.warn("Failed to decode audio");
        decodeCtx.close();
        return;
      }
      const mono = decoded.getChannelData(0);
      decodeCtx.close();

      // Show brief status
      yoPanelMicBtn!.classList.add("disabled");
      yoPanelMicBtn!.title = "Transcribing...";

      const result = await window.yo.transcribeAudio(mono.buffer as ArrayBuffer);

      yoPanelMicBtn!.classList.remove("disabled");
      yoPanelMicBtn!.title = "Voice input";

      if (result.ok && result.text) {
        deps.onTranscribed(result.text);
      } else if (!result.ok) {
        const errMsg = (result.error || "Transcription failed")
          .replace(/^Whisper API \d+:\s*/, "")
          .replace(/\{[\s\S]*$/, "")
          .trim() || "Transcription failed";
        const yoPanelMessages = document.getElementById("yo-panel-messages")!;
        const el = document.createElement("div");
        el.className = "yo-msg yo-msg-error";
        el.textContent = errMsg;
        yoPanelMessages.appendChild(el);
        yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
      }
    };

    mediaRecorder.start();
  });
}
