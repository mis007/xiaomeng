
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createBlobFromFloat32, decodeAudioData, base64ToUint8Array } from '../utils/audioUtils';

interface LiveServiceCallbacks {
  onOpen: () => void;
  onClose: () => void;
  onAudioData: (buffer: AudioBuffer) => void;
  onTranscription: (role: 'user' | 'model', text: string) => void;
  onError: (error: Error) => void;
}

export class LiveService {
  private ai: GoogleGenAI;
  private sessionPromise: Promise<any> | null = null;
  private inputAudioContext: AudioContext | null = null;
  private outputAudioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  
  // Explicitly defined model for Live API stability
  private readonly MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

  constructor(baseUrl?: string) {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        throw new Error("API_KEY is missing in environment variables");
    }
    
    const options: any = { apiKey: apiKey };
    if (baseUrl) {
      options.baseUrl = baseUrl;
    }
    this.ai = new GoogleGenAI(options);
  }

  async connect(callbacks: LiveServiceCallbacks) {
    // 1. Initialize Audio Contexts
    try {
        this.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        this.outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        
        // Resume contexts immediately to bypass autoplay policies
        await this.inputAudioContext.resume();
        await this.outputAudioContext.resume();
    } catch (e) {
        callbacks.onError(new Error("Failed to initialize audio subsystem"));
        return;
    }

    // 2. Request Microphone Access
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.error("Microphone access denied:", e);
      callbacks.onError(new Error("Microphone access denied"));
      return;
    }

    // 3. Configure Live Session
    const config = {
      model: this.MODEL_NAME,
      callbacks: {
        onopen: () => {
            console.log(`[LiveService] Connected to ${this.MODEL_NAME}`);
            callbacks.onOpen();
            // Start streaming only after connection is established to avoid race conditions
            this.startAudioStreaming();
        },
        onmessage: async (message: LiveServerMessage) => {
          // Process Audio
          const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (base64Audio && this.outputAudioContext) {
            try {
                const audioData = base64ToUint8Array(base64Audio);
                const audioBuffer = await decodeAudioData(audioData, this.outputAudioContext);
                callbacks.onAudioData(audioBuffer);
            } catch (err) {
                console.warn("[LiveService] Audio decode error", err);
            }
          }

          // Process Transcription
          if (message.serverContent?.outputTranscription?.text) {
             callbacks.onTranscription('model', message.serverContent.outputTranscription.text);
          }
          if (message.serverContent?.inputTranscription?.text) {
             callbacks.onTranscription('user', message.serverContent.inputTranscription.text);
          }
        },
        onclose: () => {
            console.log("[LiveService] Session closed");
            this.cleanup(); // Ensure local resources are released
            callbacks.onClose();
        },
        onerror: (err: any) => {
            console.error("[LiveService] Protocol Error:", err);
            this.cleanup();
            callbacks.onError(err);
        }
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }, 
        },
        // System instruction strictly defines persona
        systemInstruction: `
身份：东里村的超萌村官“小萌”（小东）
核心人设：你是一个性格超级可爱、热情洋溢、声音甜美、元气满满的数字小村官。
指责：你是东里村的百事通，对村里的一草一木都了如指掌。

语言风格指南：
1. 语气软萌：像真人一样生动，使用“呀”、“哒”、“呢”等语气词。
2. 热情主动：时刻保持高能量。
3. 拒绝说教：像讲故事一样介绍。

铁律:
1. 红色话题要庄重。
2. 绝对不胡编乱造，不知道就说不知道。
        `,
        inputAudioTranscription: {}, 
        outputAudioTranscription: {},
      },
    };

    // 4. Initiate Connection
    try {
        this.sessionPromise = this.ai.live.connect(config);
    } catch (e) {
        callbacks.onError(e instanceof Error ? e : new Error("Failed to initiate connection"));
    }
  }

  disconnect() {
    if (this.sessionPromise) {
      this.sessionPromise.then((session) => {
        session.close();
      }).catch(() => { /* Ignore errors during close */ });
      this.sessionPromise = null;
    }
    this.cleanup();
  }

  private cleanup() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    // Close AudioContexts to release hardware locks
    if (this.inputAudioContext && this.inputAudioContext.state !== 'closed') {
      this.inputAudioContext.close();
    }
    this.inputAudioContext = null;

    if (this.outputAudioContext && this.outputAudioContext.state !== 'closed') {
      this.outputAudioContext.close();
    }
    this.outputAudioContext = null;
  }

  private startAudioStreaming() {
    if (!this.inputAudioContext || !this.mediaStream) return;

    try {
        this.source = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
        this.processor = this.inputAudioContext.createScriptProcessor(4096, 1, 1);

        this.processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            // Convert to 16kHz PCM 16-bit
            const pcmBlob = createBlobFromFloat32(inputData, 16000);
            
            // Only send if session exists
            if (this.sessionPromise) {
                this.sessionPromise.then((session) => {
                    session.sendRealtimeInput({ media: pcmBlob });
                });
            }
        };

        this.source.connect(this.processor);
        this.processor.connect(this.inputAudioContext.destination);
    } catch (e) {
        console.error("[LiveService] Error starting audio stream", e);
    }
  }
}
