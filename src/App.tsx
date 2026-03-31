import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { Mic, MicOff, RotateCcw, Download, Info, Activity, Globe, Volume2, Timer, PauseCircle, PlayCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// PCM 16kHz is required by Gemini Live
const SAMPLE_RATE = 16000;

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'ru', name: 'Russian' },
];

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcription, setTranscription] = useState<string[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState(LANGUAGES[0]);
  const [volume, setVolume] = useState(1.0);
  const [isAutoPaused, setIsAutoPaused] = useState(false);
  const [silenceTimeout, setSilenceTimeout] = useState(3); // seconds
  
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const transcriptionRef = useRef<string[]>([]);
  const isAutoPausedRef = useRef(false);

  // Word count calculation
  const wordCount = transcription.join(' ').split(/\s+/).filter(w => w.length > 0).length;

  const stopRecording = useCallback(async () => {
    setIsRecording(false);
    
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (gainNodeRef.current) {
      gainNodeRef.current.disconnect();
      gainNodeRef.current = null;
    }

    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    
    setIsAutoPaused(false);
    isAutoPausedRef.current = false;
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    if (audioContextRef.current) {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (sessionRef.current) {
      const session = await sessionRef.current;
      session.close();
      sessionRef.current = null;
    }
  }, []);

  const startRecording = async () => {
    try {
      setIsConnecting(true);
      setError(null);

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const sessionPromise = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: `You are a transcription assistant. Your only job is to provide real-time transcription of the user's speech in ${selectedLanguage.name}. Do not respond verbally unless asked, just transcribe the speech exactly as it is spoken.`,
        },
        callbacks: {
          onopen: () => {
            console.log("Live session opened");
            setIsConnecting(false);
            setIsRecording(true);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              if (text) {
                // The API might send partial transcriptions or full ones.
                // For simplicity, we'll split by words and add new ones.
                const words = text.trim().split(/\s+/);
                setTranscription(prev => {
                  // We want to avoid duplicates if the API sends overlapping chunks
                  // But usually inputTranscription sends the final transcription of a segment.
                  const newTranscription = [...prev, ...words];
                  transcriptionRef.current = newTranscription;
                  return newTranscription;
                });
              }
            }
            
            if (message.serverContent?.interrupted) {
              console.log("Interrupted");
            }
          },
          onerror: (err) => {
            console.error("Live session error:", err);
            setError("Connection error. Please try again.");
            stopRecording();
          },
          onclose: () => {
            console.log("Live session closed");
            setIsRecording(false);
          }
        }
      });

      sessionRef.current = sessionPromise;

      // Setup Audio
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;
      
      const source = audioContext.createMediaStreamSource(stream);
      const gainNode = audioContext.createGain();
      gainNode.gain.value = volume;
      gainNodeRef.current = gainNode;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      processor.onaudioprocess = (e) => {
        // Monitor volume for auto-pause
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        const threshold = 5; // Silence threshold

        if (average < threshold) {
          if (!silenceTimerRef.current && !isAutoPausedRef.current) {
            silenceTimerRef.current = setTimeout(() => {
              setIsAutoPaused(true);
              isAutoPausedRef.current = true;
              console.log("Auto-paused due to silence");
            }, silenceTimeout * 1000);
          }
        } else {
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
          if (isAutoPausedRef.current) {
            setIsAutoPaused(false);
            isAutoPausedRef.current = false;
            console.log("Resumed from auto-pause");
          }
        }

        // Only send audio if not auto-paused
        if (!isAutoPausedRef.current) {
          const inputData = e.inputBuffer.getChannelData(0);
          // Convert Float32 to Int16 PCM
          const pcmData = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
          }
          
          // Convert to Base64
          const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
          
          sessionPromise.then(session => {
            session.sendRealtimeInput({
              audio: { data: base64Data, mimeType: `audio/pcm;rate=${SAMPLE_RATE}` }
            });
          });
        }
      };

      source.connect(gainNode);
      gainNode.connect(analyser);
      analyser.connect(processor);
      processor.connect(audioContext.destination);

    } catch (err) {
      console.error("Failed to start recording:", err);
      setError("Microphone access denied or connection failed.");
      setIsConnecting(false);
      stopRecording();
    }
  };

  const handleReset = () => {
    setTranscription([]);
    transcriptionRef.current = [];
  };

  const handleDownload = () => {
    const text = transcription.join(' ');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcription-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = volume;
    }
  }, [volume]);

  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, [stopRecording]);

  return (
    <div className="min-h-screen bg-[#E6E6E6] text-[#151619] font-sans p-4 md:p-8 flex flex-col items-center justify-center">
      {/* Main Widget Container */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-4xl bg-[#151619] rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[80vh]"
      >
        {/* Header / Status Bar */}
        <div className="p-6 border-b border-white/10 flex flex-col md:flex-row items-center justify-between bg-[#1a1b1f] gap-4">
          <div className="flex items-center gap-3 w-full md:w-auto">
            <div className={`w-3 h-3 rounded-full ${isRecording ? 'bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.5)]' : 'bg-gray-600'}`} />
            <h1 className="text-white font-mono text-sm tracking-widest uppercase">EchoScribe v1.1</h1>
          </div>
          
          <div className="flex items-center gap-4 md:gap-6 w-full md:w-auto justify-between md:justify-end">
            {/* Language Selector */}
            <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-lg border border-white/10">
              <Globe className="w-3.5 h-3.5 text-gray-500" />
              <select 
                value={selectedLanguage.code}
                onChange={(e) => {
                  const lang = LANGUAGES.find(l => l.code === e.target.value);
                  if (lang) setSelectedLanguage(lang);
                }}
                disabled={isRecording || isConnecting}
                className="bg-transparent text-white font-mono text-[11px] uppercase tracking-wider outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {LANGUAGES.map(lang => (
                  <option key={lang.code} value={lang.code} className="bg-[#151619] text-white">
                    {lang.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-4 md:gap-6">
              <div className="flex flex-col items-end">
                <span className="text-[10px] font-mono text-gray-500 uppercase tracking-tighter">Word Count</span>
                <span className="text-white font-mono text-xl leading-none">{wordCount.toString().padStart(4, '0')}</span>
              </div>
              <div className="h-8 w-[1px] bg-white/10" />
              <div className="flex flex-col items-end">
                <span className="text-[10px] font-mono text-gray-500 uppercase tracking-tighter">Status</span>
                <span className={`font-mono text-sm leading-none ${isAutoPaused ? 'text-yellow-500' : isRecording ? 'text-red-400' : isConnecting ? 'text-yellow-400' : 'text-gray-400'}`}>
                  {isAutoPaused ? 'AUTO-PAUSED' : isRecording ? 'RECORDING' : isConnecting ? 'CONNECTING' : 'READY'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Transcription Area */}
        <div className="flex-1 p-8 overflow-y-auto custom-scrollbar bg-[#0d0e11] relative">
          <div className="max-w-3xl mx-auto">
            {transcription.length === 0 && !isRecording && !isConnecting && (
              <div className="h-full flex flex-col items-center justify-center text-gray-600 mt-20">
                <Activity className="w-12 h-12 mb-4 opacity-20" />
                <p className="font-mono text-sm uppercase tracking-widest">Awaiting Input Signal...</p>
              </div>
            )}
            
            <div className="flex flex-wrap gap-x-2 gap-y-1">
              <AnimatePresence mode="popLayout">
                {transcription.map((word, i) => (
                  <motion.span
                    key={`${word}-${i}`}
                    initial={{ opacity: 0, y: 5, filter: 'blur(4px)' }}
                    animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                    transition={{ duration: 0.2 }}
                    className="text-gray-300 font-mono text-lg md:text-xl leading-relaxed hover:text-white transition-colors"
                  >
                    {word}
                  </motion.span>
                ))}
              </AnimatePresence>
              {isRecording && (
                <motion.span 
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ repeat: Infinity, duration: 1.5 }}
                  className="w-2 h-6 bg-red-500/50 self-center ml-1"
                />
              )}
            </div>
          </div>
          
          {error && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-red-900/80 text-red-200 px-4 py-2 rounded-full text-xs font-mono border border-red-500/50 backdrop-blur-sm">
              {error}
            </div>
          )}
        </div>

        {/* Controls Footer */}
        <div className="p-8 bg-[#1a1b1f] border-t border-white/10 flex flex-col lg:flex-row items-center justify-between gap-8">
          <div className="flex flex-wrap items-center justify-center gap-6">
            <div className="flex gap-4">
              <button
                onClick={handleReset}
                disabled={transcription.length === 0 || isRecording}
                className="group flex flex-col items-center gap-1 disabled:opacity-30 transition-all"
              >
                <div className="p-3 rounded-full border border-white/10 group-hover:bg-white/5 transition-colors">
                  <RotateCcw className="w-5 h-5 text-gray-400 group-hover:text-white" />
                </div>
                <span className="text-[9px] font-mono text-gray-500 uppercase tracking-widest">Reset</span>
              </button>
              
              <button
                onClick={handleDownload}
                disabled={transcription.length === 0 || isRecording}
                className="group flex flex-col items-center gap-1 disabled:opacity-30 transition-all"
              >
                <div className="p-3 rounded-full border border-white/10 group-hover:bg-white/5 transition-colors">
                  <Download className="w-5 h-5 text-gray-400 group-hover:text-white" />
                </div>
                <span className="text-[9px] font-mono text-gray-500 uppercase tracking-widest">Export</span>
              </button>
            </div>

            <div className="h-10 w-[1px] bg-white/10 hidden sm:block" />

            <div className="flex flex-col gap-2 w-32">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-mono text-gray-500 uppercase tracking-widest">Input Vol</span>
                <span className="text-[9px] font-mono text-white">{Math.round(volume * 100)}%</span>
              </div>
              <div className="flex items-center gap-2">
                <Volume2 className="w-3 h-3 text-gray-500" />
                <input 
                  type="range" 
                  min="0" 
                  max="2" 
                  step="0.1" 
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
                />
              </div>
            </div>

            <div className="h-10 w-[1px] bg-white/10 hidden sm:block" />

            <div className="flex flex-col gap-2 w-32">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-mono text-gray-500 uppercase tracking-widest flex items-center gap-1">
                  <Timer className="w-3 h-3" /> Silence
                </span>
                <span className="text-[9px] font-mono text-white">{silenceTimeout}s</span>
              </div>
              <input 
                type="range" 
                min="1" 
                max="10" 
                step="1" 
                value={silenceTimeout}
                onChange={(e) => setSilenceTimeout(parseInt(e.target.value))}
                disabled={isRecording || isConnecting}
                className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white disabled:opacity-30"
              />
            </div>
          </div>

          <button
            onClick={isRecording ? stopRecording : startRecording}
            disabled={isConnecting}
            className={`relative flex items-center gap-4 px-8 py-4 rounded-full transition-all duration-300 ${
              isAutoPaused
                ? 'bg-yellow-500 text-[#151619] shadow-[0_0_20px_rgba(234,179,8,0.3)]'
                : isRecording 
                  ? 'bg-red-500 hover:bg-red-600 text-white shadow-[0_0_20px_rgba(239,68,68,0.3)]' 
                  : 'bg-white hover:bg-gray-200 text-[#151619]'
            } disabled:opacity-50`}
          >
            {isRecording ? (
              <>
                {isAutoPaused ? <PlayCircle className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
                <span className="font-mono font-bold uppercase tracking-widest">
                  {isAutoPaused ? 'Waiting for Speech' : 'Stop Capture'}
                </span>
              </>
            ) : (
              <>
                <Mic className="w-6 h-6" />
                <span className="font-mono font-bold uppercase tracking-widest">
                  {isConnecting ? 'Initializing...' : 'Start Capture'}
                </span>
              </>
            )}
          </button>

          <div className="hidden xl:flex flex-col items-end gap-1">
            <div className="flex items-center gap-2 text-gray-500">
              <Info className="w-3 h-3" />
              <span className="text-[9px] font-mono uppercase tracking-widest">System Info</span>
            </div>
            <span className="text-[9px] font-mono text-gray-700 uppercase tracking-widest text-right">PCM 16KHZ / MONO / GEMINI-3.1-LIVE</span>
          </div>
        </div>
      </motion.div>

      {/* Background decorative elements */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none opacity-20">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-red-500/20 blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-blue-500/10 blur-[120px]" />
        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] opacity-5" />
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}} />
    </div>
  );
}
