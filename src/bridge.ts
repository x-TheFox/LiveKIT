import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import {
  AudioPlayer,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnection,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import prism from 'prism-media';
import { Readable } from 'node:stream';

const DISCORD_SAMPLE_RATE = 48_000;
const DISCORD_CHANNELS = 2;
const LIVEKIT_SAMPLE_RATE = 48_000;
const LIVEKIT_CHANNELS = 1;
// 20ms frames @ 48kHz mono = 960 samples per channel
const SAMPLES_PER_CHANNEL = 960;

export class AudioBridge {
  private audioSource: AudioSource;
  private audioPlayer: AudioPlayer;
  private receiveStreams = new Map<string, import('node:stream').Readable>();
  private destroyed = false;
  private agentStreamReader: ReadableStreamDefaultReader<AudioFrame> | null = null;

  constructor(
    private voiceConnection: VoiceConnection,
    private livekitRoom: Room,
  ) {
    this.audioSource = new AudioSource(LIVEKIT_SAMPLE_RATE, LIVEKIT_CHANNELS);
    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });
    voiceConnection.subscribe(this.audioPlayer);
  }

  async start(): Promise<void> {
    await this.publishDiscordAudioToLiveKit();
    this.listenForAgentAudio();
  }

  /** Publish discord-bridge participant's mic audio track into the LiveKit room */
  private async publishDiscordAudioToLiveKit(): Promise<void> {
    const track = LocalAudioTrack.createAudioTrack('discord-input', this.audioSource);
    await this.livekitRoom.localParticipant!.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );

    // Subscribe to each speaking user and pipe their opus → PCM → AudioSource
    this.voiceConnection.receiver.speaking.on('start', (userId: string) => {
      if (this.destroyed || this.receiveStreams.has(userId)) return;
      this.subscribeUser(userId);
    });
  }

  private subscribeUser(userId: string): void {
    const opusStream = this.voiceConnection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
    });

    const pcmDecoder = new prism.opus.Decoder({
      rate: DISCORD_SAMPLE_RATE,
      channels: DISCORD_CHANNELS,
      frameSize: SAMPLES_PER_CHANNEL,
    });

    opusStream.pipe(pcmDecoder as unknown as NodeJS.WritableStream);
    this.receiveStreams.set(userId, opusStream as unknown as import('node:stream').Readable);

    pcmDecoder.on('data', (chunk: Buffer) => {
      if (this.destroyed) return;
      this.pushPcmToLiveKit(chunk);
    });

    opusStream.on('end', () => {
      this.receiveStreams.delete(userId);
    });

    opusStream.on('error', (err: Error) => {
      console.error(`[bridge] opus stream error for user ${userId}:`, err);
      this.receiveStreams.delete(userId);
    });
  }

  /**
   * Discord audio: 48kHz stereo (interleaved) → mono by averaging L+R → AudioFrame
   */
  private pushPcmToLiveKit(stereoBuffer: Buffer): void {
    const stereoSamples = new Int16Array(
      stereoBuffer.buffer,
      stereoBuffer.byteOffset,
      stereoBuffer.byteLength / 2,
    );

    const monoLength = stereoSamples.length / DISCORD_CHANNELS;
    const mono = new Int16Array(monoLength);
    for (let i = 0; i < monoLength; i++) {
      // average L + R channels
      mono[i] = Math.round((stereoSamples[i * 2] + stereoSamples[i * 2 + 1]) / 2);
    }

    const frame = new AudioFrame(
      mono,
      LIVEKIT_SAMPLE_RATE,
      LIVEKIT_CHANNELS,
      monoLength,
    );

    this.audioSource.captureFrame(frame).catch((err) => {
      if (!this.destroyed) console.error('[bridge] captureFrame error:', err);
    });
  }

  /** Listen for the LiveKit agent's audio track and play it in the Discord VC */
  private listenForAgentAudio(): void {
    this.livekitRoom.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (this.destroyed) return;
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      // Only play audio from the AI agent, not the bridge participant itself
      if (participant.identity === 'discord-bridge') return;

      console.log(`[bridge] agent audio track subscribed from ${participant.identity}`);
      this.playAgentTrack(track as import('@livekit/rtc-node').RemoteAudioTrack);
    });

    // Handle tracks that were already subscribed before this listener was registered
    for (const [, participant] of this.livekitRoom.remoteParticipants) {
      if (participant.identity === 'discord-bridge') continue;
      for (const [, publication] of participant.trackPublications) {
        if (publication.subscribed && publication.track?.kind === TrackKind.KIND_AUDIO) {
          console.log(`[bridge] found existing agent audio track from ${participant.identity}`);
          this.playAgentTrack(publication.track as import('@livekit/rtc-node').RemoteAudioTrack);
        }
      }
    }
  }

  private async playAgentTrack(track: import('@livekit/rtc-node').RemoteAudioTrack): Promise<void> {
    if (this.agentStreamReader) {
      this.agentStreamReader.cancel();
    }

    const audioStream = new AudioStream(track, DISCORD_SAMPLE_RATE, DISCORD_CHANNELS);
    this.agentStreamReader = audioStream.getReader();

    const nodeReadable = new Readable({
      read() {},
    });

    const resource = createAudioResource(nodeReadable, { inputType: StreamType.Raw });
    this.audioPlayer.play(resource);

    // Feed PCM frames from LiveKit into the Readable stream for the Discord audio player
    (async () => {
      const reader = this.agentStreamReader!;
      try {
        while (true) {
          const { value: frame, done } = await reader.read();
          if (done || this.destroyed) break;
          if (!frame) continue;

          // Convert Int16Array data to Buffer and push into the readable
          const buf = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
          if (!nodeReadable.destroyed) {
            nodeReadable.push(buf);
          }
        }
      } catch (err) {
        if (!this.destroyed) console.error('[bridge] agent audio read error:', err);
      } finally {
        if (!nodeReadable.destroyed) nodeReadable.push(null);
      }
    })();
  }

  /** Send a text message into the LiveKit room for the agent to reply to via TTS */
  async sendText(username: string, text: string): Promise<void> {
    if (this.destroyed) return;
    const payload = JSON.stringify({ type: 'discord_text', username, text });
    const encoded = new TextEncoder().encode(payload);
    await this.livekitRoom.localParticipant!.publishData(encoded, { reliable: true, topic: 'discord_chat' });
  }

  async destroy(): Promise<void> {    this.destroyed = true;

    if (this.agentStreamReader) {
      await this.agentStreamReader.cancel().catch(() => {});
      this.agentStreamReader = null;
    }

    for (const stream of this.receiveStreams.values()) {
      stream.destroy();
    }
    this.receiveStreams.clear();

    this.audioPlayer.stop();
    await this.audioSource.close();
  }
}
