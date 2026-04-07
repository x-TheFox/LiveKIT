import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  voice,
} from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { RoomEvent } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Assistant } from './assistant.js';

dotenv.config();

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const vad = ctx.proc.userData.vad as silero.VAD;

    const session = new voice.AgentSession({
      vad,
      stt: new inference.STT({ language: 'multi' }),
      llm: openai.LLM.withGroq({
        model: 'openai/gpt-oss-120b',
        apiKey: process.env.GROQ_API_KEY,
        temperature: 0.7,
      }),
      tts: new cartesia.TTS({
        model: 'sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
        language: 'en',
      }),
      turnHandling: {
        turnDetection: new livekit.turnDetector.MultilingualModel(),
        endpointing: { minDelay: 300, maxDelay: 2000 },
      },
    });

    await session.start({
      agent: new Assistant(),
      room: ctx.room,
    });

    // Handle text messages sent from Discord via the data channel
    ctx.room.on(RoomEvent.DataReceived, (payload: Uint8Array, _participant, _kind, topic?: string) => {
      if (topic !== 'discord_chat') return;
      try {
        const { username, text } = JSON.parse(new TextDecoder().decode(payload)) as {
          type: string;
          username: string;
          text: string;
        };
        console.log(`[agent] text message from Discord user ${username}: ${text}`);
        session.generateReply({ userInput: `${username} says: ${text}` });
      } catch {
        console.error('[agent] failed to parse text message from Discord');

      }
    });

    session.generateReply({
      instructions: 'Greet the users in the Discord voice channel warmly and let them know you are ready to chat.',
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'discord-voice-agent',
  }),
);
