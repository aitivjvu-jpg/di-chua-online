import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SoundEngine } from '../src/services/soundEngine';

class FakeAudio {
  static instances: FakeAudio[] = [];
  static rejectNextPlay = false;

  src: string;
  volume = 1;
  onended: ((this: GlobalEventHandlers, ev: Event) => unknown) | null = null;
  onerror: ((this: GlobalEventHandlers, ev: Event) => unknown) | null = null;
  paused = false;

  constructor(src = '') {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  play(): Promise<void> {
    if (FakeAudio.rejectNextPlay) {
      FakeAudio.rejectNextPlay = false;
      return Promise.reject(new Error('Autoplay blocked'));
    }
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function installFakeAudio() {
  const originalAudio = globalThis.Audio;
  FakeAudio.instances = [];
  FakeAudio.rejectNextPlay = false;
  globalThis.Audio = FakeAudio as unknown as typeof Audio;
  return () => {
    globalThis.Audio = originalAudio;
  };
}

test('continues queued speech after audio.play() is rejected', async () => {
  const restoreAudio = installFakeAudio();
  const engine = new SoundEngine();
  try {
    FakeAudio.rejectNextPlay = true;
    engine.speakPreferredBuddhistVoice('Câu thứ nhất');
    engine.speakPreferredBuddhistVoice('Câu thứ hai');

    await delay(360);

    assert.equal(FakeAudio.instances.length, 2, 'the second sentence should start after the first play rejection');
    assert.equal(engine.queuedSpeech(), 0);
  } finally {
    engine.dispose();
    restoreAudio();
  }
});

test('handles ended and error callbacks only once for the same audio', async () => {
  const restoreAudio = installFakeAudio();
  const engine = new SoundEngine();
  try {
    engine.speakPreferredBuddhistVoice('Câu đang phát');
    engine.speakPreferredBuddhistVoice('Câu tiếp theo');

    const first = FakeAudio.instances[0];
    const ended = first.onended;
    const errored = first.onerror;
    assert.ok(ended);
    assert.ok(errored);

    ended.call(first as unknown as GlobalEventHandlers, new Event('ended'));
    errored.call(first as unknown as GlobalEventHandlers, new Event('error'));
    await delay(360);

    assert.equal(FakeAudio.instances.length, 2, 'duplicate terminal events must not start duplicate players');
  } finally {
    engine.dispose();
    restoreAudio();
  }
});
