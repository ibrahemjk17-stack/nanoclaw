/**
 * Jarvis: the owner's Telegram voice notes, transcribed LOCALLY (Phase 2e; docs/proposals/phase-2e-plan.md).
 *
 * The Telegram bridge already puts a voice note's OGG/Opus bytes into the inbound event as a `voice` attachment. For the OWNER's
 * voice notes the interceptor takes the message out of routing, sends the audio to the jarvis-stt service (whisper.cpp in a local
 * container; never a cloud API), optionally echoes "🎤 heard: …" into the same topic, then routes the message again as TEXT with the
 * audio removed: it is never written to an agent's inbox and never leaves the PC. Language and confidence (never the text) go to
 * activity_log for the language-rule review. No model is called here.
 *
 * The work runs in the background: routing does not wait (a 20–30 s transcription never delays /stop or other messages).
 */

export interface SttAnswer {
  text: string;
  detected: string;
  p: number;
  language: 'en' | 'ar';
  audio_s: number;
  ms: number;
  echo: boolean;
}

/** A failure the STT service explained (`code`), or a transport failure (`code` = "unreachable"). */
export class SttFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SttFailure';
  }
}

export interface VoiceEvent {
  message: { content: string };
}

export interface VoiceDeps<E extends VoiceEvent> {
  transcribe: (audio: Buffer) => Promise<SttAnswer>;
  /** Puts the (rewritten) event back into normal routing. */
  reroute: (event: E) => Promise<void>;
  /** Posts a line into the event's chat/topic. */
  reply: (event: E, text: string) => Promise<void>;
  /** Writes the voice.transcribed log row (data server /host/voice-log). */
  logVoice: (detail: {
    group: string | null;
    detected: string;
    p: number;
    language: 'en' | 'ar';
    audio_s: number;
    ms: number;
  }) => Promise<void>;
  /** The agent group wired to the event's chat, best effort (for the log only). */
  groupOf: (event: E) => Promise<string | null>;
  warn: (msg: string, extra?: unknown) => void;
  trace?: (msg: string, extra?: unknown) => void;
}

const ECHO_MAX = 900;

/** Marker on a re-routed message so it is never transcribed twice. */
export const VOICE_MARKER = 'jarvisVoice';

interface Found {
  content: Record<string, unknown>;
  audio: Buffer;
}

/**
 * Is this attachment a Telegram voice note? @chat-adapter/telegram (4.29.0, createAttachment in dist/index.js) maps BOTH `message.voice`
 * and `message.audio` to type "audio"; only `audio` (a music/audio file) carries a file name. So a voice note is an "audio" attachment,
 * audio/ogg, with no name. "voice" is accepted too in case an adapter labels it so. Audio files and video notes are not handled.
 */
export function isVoiceNote(a: Record<string, unknown> | null | undefined): boolean {
  if (!a) return false;
  if (a.type === 'voice') return true;
  return a.type === 'audio' && a.mimeType === 'audio/ogg' && (a.name === undefined || a.name === null || a.name === '');
}

/** The voice attachment of a message (with its bytes), or null. */
export function findVoice(contentJson: string): Found | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(contentJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!content || typeof content !== 'object' || content[VOICE_MARKER]) return null;
  const atts = Array.isArray(content.attachments) ? (content.attachments as Record<string, unknown>[]) : [];
  const voice = atts.find((a) => isVoiceNote(a) && typeof a.data === 'string' && a.data.length > 0);
  if (!voice) return null;
  const audio = Buffer.from(voice.data as string, 'base64');
  return audio.length > 0 ? { content, audio } : null;
}

/** The text the agent receives instead of the audio. */
export function voiceText(text: string, language: 'en' | 'ar'): string {
  return `🎤 Voice note (${language === 'ar' ? 'Arabic' : 'English'}, transcribed locally; small recognition errors are possible):\n${text}`;
}

export function echoText(text: string): string {
  const t = text.length > ECHO_MAX ? `${text.slice(0, ECHO_MAX - 1)}…` : text;
  return `🎤 heard: ${t}`;
}

/** What the owner is told when a voice note cannot be used. Never routed further. */
export function failureText(f: SttFailure): string {
  switch (f.code) {
    case 'too_long':
      return `🎤 That voice note is too long to transcribe (${f.message.replace(/^the voice note is /, '')}). Please split it or send text.`;
    case 'bad_audio':
      return '🎤 I could not read that voice note. Please try again or send text.';
    case 'busy':
      return '🎤 Too many voice notes are waiting. Please send this one again in a minute.';
    default:
      return '🎤 I could not transcribe that voice note (the speech service is not available). Please send it as text.';
  }
}

/**
 * Handles the owner's voice note in the background. Returns true when the message was a voice note and was taken out of routing
 * (it will come back as text, or the owner gets a notice); false for anything else (routing continues unchanged).
 */
export function handleOwnerVoice<E extends VoiceEvent>(event: E, deps: VoiceDeps<E>): boolean {
  const found = findVoice(event.message.content);
  if (!found) return false;
  void processVoice(event, found, deps);
  return true;
}

async function processVoice<E extends VoiceEvent>(event: E, found: Found, deps: VoiceDeps<E>): Promise<void> {
  let answer: SttAnswer;
  try {
    answer = await deps.transcribe(found.audio);
  } catch (err) {
    const f =
      err instanceof SttFailure ? err : new SttFailure('unreachable', err instanceof Error ? err.message : 'unknown');
    if (f.code === 'disabled') {
      // features.voice is off: behave as before Phase 2e (the voice note goes to the agent unchanged)
      await deps.reroute(event).catch((e) => deps.warn('Voice: could not route the untouched voice note', e));
      return;
    }
    deps.warn('Voice: transcription failed', { code: f.code, message: f.message.slice(0, 200) });
    await deps.reply(event, failureText(f)).catch(() => undefined);
    return;
  }

  const group = await deps.groupOf(event).catch(() => null);
  await deps
    .logVoice({
      group,
      detected: answer.detected,
      p: answer.p,
      language: answer.language,
      audio_s: answer.audio_s,
      ms: answer.ms,
    })
    .catch((e) => deps.warn('Voice: could not write the log row', e instanceof Error ? e.message : e));
  deps.trace?.('Voice note transcribed', {
    group,
    detected: answer.detected,
    p: answer.p,
    language: answer.language,
    ms: answer.ms,
  });

  if (!answer.text) {
    await deps.reply(event, '🎤 I heard nothing in that voice note.').catch(() => undefined);
    return;
  }
  if (answer.echo) await deps.reply(event, echoText(answer.text)).catch(() => undefined);

  // The audio is dropped here: the re-routed message carries only the text (no attachment bytes reach the agent's inbox).
  const attachments = Array.isArray(found.content.attachments)
    ? (found.content.attachments as Record<string, unknown>[]).filter((a) => !isVoiceNote(a))
    : [];
  const content = {
    ...found.content,
    text: voiceText(answer.text, answer.language),
    attachments,
    [VOICE_MARKER]: { language: answer.language, detected: answer.detected, p: answer.p },
  };
  await deps
    .reroute({ ...event, message: { ...event.message, content: JSON.stringify(content) } })
    .catch((e) => deps.warn('Voice: could not route the transcribed message', e));
}
