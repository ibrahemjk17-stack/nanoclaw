import { describe, expect, it } from 'vitest';

import {
  echoText,
  failureText,
  findVoice,
  handleOwnerVoice,
  isVoiceNote,
  SttFailure,
  VOICE_MARKER,
  voiceText,
  type SttAnswer,
  type VoiceDeps,
} from './voice.js';

const AUDIO = Buffer.from('OggS fake opus bytes');
const voiceEvent = (extra: Record<string, unknown> = {}) => ({
  channelType: 'telegram',
  platformId: 'telegram:-100:4',
  message: {
    id: 'm1',
    content: JSON.stringify({
      text: '',
      author: { userId: 'telegram:555' },
      attachments: [
        // the shape @chat-adapter/telegram + the bridge really produce for a voice note (seen live 2026-10-21): type "audio", no name
        { type: 'audio', mimeType: 'audio/ogg', size: AUDIO.length, data: AUDIO.toString('base64') },
        { type: 'image', name: 'x.png', data: 'aW1n' },
      ],
      ...extra,
    }),
  },
});
type Ev = ReturnType<typeof voiceEvent>;
const answer = (o: Partial<SttAnswer> = {}): SttAnswer => ({
  text: 'ذكرني اشرب مي',
  detected: 'ar',
  p: 0.98,
  language: 'ar',
  audio_s: 6.2,
  ms: 21000,
  echo: true,
  ...o,
});

function harness(transcribe: (a: Buffer) => Promise<SttAnswer>) {
  const calls = {
    replies: [] as string[],
    rerouted: [] as Ev[],
    logs: [] as unknown[],
    audio: [] as Buffer[],
    warns: [] as string[],
  };
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const deps: VoiceDeps<Ev> = {
    transcribe: async (a) => {
      calls.audio.push(a);
      return transcribe(a);
    },
    reroute: async (e) => {
      calls.rerouted.push(e);
      done();
    },
    reply: async (_e, t) => {
      calls.replies.push(t);
      if (!t.startsWith('🎤 heard:')) done();
    },
    logVoice: async (d) => {
      calls.logs.push(d);
    },
    groupOf: async () => 'life',
    warn: (m) => calls.warns.push(m),
  };
  return { deps, calls, finished };
}

describe('findVoice', () => {
  it('finds a voice attachment with its bytes', () => {
    const f = findVoice(voiceEvent().message.content);
    expect(f?.audio.equals(AUDIO)).toBe(true);
  });
  it('ignores text, other attachments, broken JSON and messages already transcribed', () => {
    expect(findVoice(JSON.stringify({ text: 'hello' }))).toBeNull();
    expect(findVoice(JSON.stringify({ attachments: [{ type: 'audio', data: 'eA==' }] }))).toBeNull();
    expect(findVoice(JSON.stringify({ attachments: [{ type: 'voice' }] }))).toBeNull();
    expect(findVoice('{nope')).toBeNull();
    expect(findVoice(voiceEvent({ [VOICE_MARKER]: { language: 'en' } }).message.content)).toBeNull();
  });
  it('does not take a music/audio FILE (it has a file name) or a non-OGG audio for a voice note', () => {
    const file = { type: 'audio', mimeType: 'audio/ogg', name: 'song.ogg', data: 'eA==' };
    const mp3 = { type: 'audio', mimeType: 'audio/mpeg', data: 'eA==' };
    expect(findVoice(JSON.stringify({ attachments: [file] }))).toBeNull();
    expect(findVoice(JSON.stringify({ attachments: [mp3] }))).toBeNull();
  });
});

describe('isVoiceNote', () => {
  it('matches how @chat-adapter/telegram labels a voice note (audio, audio/ogg, no name), and "voice"', () => {
    expect(isVoiceNote({ type: 'audio', mimeType: 'audio/ogg', size: 8740 })).toBe(true);
    expect(isVoiceNote({ type: 'voice', mimeType: 'audio/ogg' })).toBe(true);
    expect(isVoiceNote({ type: 'audio', mimeType: 'audio/ogg', name: 'track.ogg' })).toBe(false);
    expect(isVoiceNote({ type: 'audio', mimeType: 'audio/mpeg' })).toBe(false);
    expect(isVoiceNote({ type: 'image', mimeType: 'image/png' })).toBe(false);
    expect(isVoiceNote(null)).toBe(false);
  });
});

describe('handleOwnerVoice', () => {
  it('leaves non-voice messages to normal routing', () => {
    const h = harness(async () => answer());
    const e = { ...voiceEvent(), message: { id: 'm2', content: JSON.stringify({ text: 'hi' }) } };
    expect(handleOwnerVoice(e, h.deps)).toBe(false);
    expect(h.calls.audio).toHaveLength(0);
  });

  it('takes the note out of routing at once, without waiting for the transcription', () => {
    const h = harness(() => new Promise<SttAnswer>(() => undefined)); // never resolves
    expect(handleOwnerVoice(voiceEvent(), h.deps)).toBe(true);
    expect(h.calls.rerouted).toHaveLength(0);
  });

  it('echoes, logs language and confidence (no text), and re-routes the message as text with the audio removed', async () => {
    const h = harness(async () => answer());
    handleOwnerVoice(voiceEvent(), h.deps);
    await h.finished;
    expect(h.calls.audio[0]!.equals(AUDIO)).toBe(true);
    expect(h.calls.replies).toEqual(['🎤 heard: ذكرني اشرب مي']);
    expect(h.calls.logs).toEqual([{ group: 'life', detected: 'ar', p: 0.98, language: 'ar', audio_s: 6.2, ms: 21000 }]);
    expect(JSON.stringify(h.calls.logs)).not.toContain('مي');
    expect(h.calls.rerouted).toHaveLength(1);
    const c = JSON.parse(h.calls.rerouted[0]!.message.content);
    expect(c.text).toBe(voiceText('ذكرني اشرب مي', 'ar'));
    expect(c.attachments).toEqual([{ type: 'image', name: 'x.png', data: 'aW1n' }]);
    expect(h.calls.rerouted[0]!.message.content).not.toContain(AUDIO.toString('base64'));
    expect(c[VOICE_MARKER]).toEqual({ language: 'ar', detected: 'ar', p: 0.98 });
    expect(c.author).toEqual({ userId: 'telegram:555' }); // the sender is kept, so access rules still apply
    expect(findVoice(h.calls.rerouted[0]!.message.content)).toBeNull(); // never transcribed twice
  });

  it('does not echo when the setting is off', async () => {
    const h = harness(async () => answer({ echo: false, text: 'Hey Jarvis', language: 'en', detected: 'ar', p: 0.52 }));
    handleOwnerVoice(voiceEvent(), h.deps);
    await h.finished;
    expect(h.calls.replies).toEqual([]);
    expect(JSON.parse(h.calls.rerouted[0]!.message.content).text).toBe(voiceText('Hey Jarvis', 'en'));
  });

  it('tells the owner and routes nothing when transcription fails', async () => {
    for (const [code, msg, expected] of [
      ['too_long', 'the voice note is 150 s; the limit is 120 s', /too long.*150 s; the limit is 120 s/],
      ['bad_audio', 'x', /could not read/],
      ['unreachable', 'ECONNREFUSED', /not available/],
      ['timeout', 'x', /not available/],
      ['busy', 'x', /waiting/],
    ] as const) {
      const h = harness(async () => {
        throw new SttFailure(code, msg);
      });
      handleOwnerVoice(voiceEvent(), h.deps);
      await h.finished;
      expect(h.calls.replies).toHaveLength(1);
      expect(h.calls.replies[0]).toMatch(expected);
      expect(h.calls.rerouted).toHaveLength(0);
      expect(h.calls.logs).toHaveLength(0);
    }
  });

  it('treats an unknown error as the service being unavailable', async () => {
    const h = harness(async () => {
      throw new Error('socket hang up');
    });
    handleOwnerVoice(voiceEvent(), h.deps);
    await h.finished;
    expect(h.calls.replies[0]).toMatch(/not available/);
  });

  it('routes the voice note unchanged when voice is turned off (features.voice = false)', async () => {
    const h = harness(async () => {
      throw new SttFailure('disabled', 'off');
    });
    const e = voiceEvent();
    handleOwnerVoice(e, h.deps);
    await h.finished;
    expect(h.calls.rerouted).toEqual([e]);
    expect(h.calls.replies).toEqual([]);
  });

  it('says so when nothing was heard, and routes nothing', async () => {
    const h = harness(async () => answer({ text: '' }));
    handleOwnerVoice(voiceEvent(), h.deps);
    await h.finished;
    expect(h.calls.replies).toEqual(['🎤 I heard nothing in that voice note.']);
    expect(h.calls.rerouted).toHaveLength(0);
  });

  it('still routes the text when the log row cannot be written', async () => {
    const h = harness(async () => answer());
    h.deps.logVoice = async () => {
      throw new Error('data server down');
    };
    handleOwnerVoice(voiceEvent(), h.deps);
    await h.finished;
    expect(h.calls.rerouted).toHaveLength(1);
    expect(h.calls.warns.join()).toMatch(/log row/);
  });
});

describe('texts', () => {
  it('shortens a long echo', () => {
    const t = echoText('a'.repeat(2000));
    expect(t.length).toBeLessThanOrEqual('🎤 heard: '.length + 900);
    expect(t.endsWith('…')).toBe(true);
  });
  it('explains a too-long note with its length', () => {
    expect(failureText(new SttFailure('too_long', 'the voice note is 150 s; the limit is 120 s'))).toContain(
      '150 s; the limit is 120 s',
    );
  });
});
