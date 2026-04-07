import {
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  GuildMember,
  VoiceChannel,
  Events,
  Message,
} from 'discord.js';
import {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import { Room } from '@livekit/rtc-node';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import dotenv from 'dotenv';
import { AudioBridge } from './bridge.js';

dotenv.config();

const LIVEKIT_URL = process.env.LIVEKIT_URL!;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY!;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!;

// Map of guild ID → active bridge
const activeBridges = new Map<string, { bridge: AudioBridge; room: Room }>();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, 
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  await interaction.deferReply({ ephemeral: true });

  if (commandName === 'join') {
    await handleJoin(interaction);
  } else if (commandName === 'leave') {
    await handleLeave(interaction);
  } else if (commandName === 'say') {
    await handleSay(interaction);
  }
});

// @mention in text channel → relay to agent TTS
client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (!client.user || !message.mentions.has(client.user)) return;

  const guildId = message.guildId;
  if (!guildId) return;

  const entry = activeBridges.get(guildId);
  if (!entry) {
    await message.reply('I\'m not in a voice channel right now. Use `/join` to bring me in!');
    return;
  }

  const text = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!text) return;

  await entry.bridge.sendText(message.author.displayName ?? message.author.username, text);
  await message.react('🔊');
});

async function handleJoin(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = interaction.member as GuildMember;
  const guildId = interaction.guildId as string;

  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel || voiceChannel.type !== 2) {
    await interaction.editReply('You need to be in a voice channel first!');
    return;
  }

  if (activeBridges.has(guildId)) {
    await interaction.editReply('I\'m already in a voice channel! Use `/leave` first.');
    return;
  }

  const vc = voiceChannel as VoiceChannel;
  const roomName = `discord-${guildId}-${vc.id}`;

  try {
    // Create LiveKit room
    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await roomService.createRoom({ name: roomName, emptyTimeout: 300 });

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: 'discord-bridge',
      name: 'Discord Bridge',
    });
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });
    const jwt = await token.toJwt();

    // Connect bridge participant to LiveKit room BEFORE dispatching the agent
    // so the TrackSubscribed listener is registered before the agent joins
    const livekitRoom = new Room();
    await livekitRoom.connect(LIVEKIT_URL, jwt, {
      autoSubscribe: true,
      dynacast: false,
    });
    console.log(`[bot] Connected to LiveKit room: ${roomName}`);

    // Join Discord voice channel (DAVE handled automatically by @discordjs/voice)
    const voiceConnection = joinVoiceChannel({
      channelId: vc.id,
      guildId,
      adapterCreator: vc.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    await entersState(voiceConnection, VoiceConnectionStatus.Ready, 30_000);
    console.log(`[bot] Joined Discord voice channel: ${vc.name}`);

    // Start the bridge — registers TrackSubscribed listener BEFORE dispatching agent
    const bridge = new AudioBridge(voiceConnection, livekitRoom);
    await bridge.start();

    activeBridges.set(guildId, { bridge, room: livekitRoom });

    // Clean up if disconnected externally
    voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
      await cleanup(guildId);
    });

    // Dispatch the agent AFTER the bridge is fully ready so we never miss its tracks
    const agentDispatch = new AgentDispatchClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await agentDispatch.createDispatch(roomName, 'discord-voice-agent');
    console.log(`[bot] Dispatched agent to room: ${roomName}`);

    await interaction.editReply(`Joined **${vc.name}**! The AI assistant is ready — just start talking.`);
  } catch (err) {
    console.error('[bot] Failed to join:', err);
    await cleanup(guildId);
    await interaction.editReply('Failed to join the voice channel. Please try again.');
  }
}

async function handleSay(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId as string;
  const text = interaction.options.getString('message', true);

  const entry = activeBridges.get(guildId);
  if (!entry) {
    await interaction.editReply('I\'m not in a voice channel right now. Use `/join` to bring me in!');
    return;
  }

  const member = interaction.member as GuildMember;
  const username = member?.displayName ?? interaction.user.username;

  await entry.bridge.sendText(username, text);
  await interaction.editReply(`Got it — replying out loud to: *"${text}"*`);
}

async function handleLeave(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId as string;

  if (!activeBridges.has(guildId)) {
    await interaction.editReply('I\'m not in a voice channel right now.');
    return;
  }

  const existingConnection = getVoiceConnection(guildId);
  existingConnection?.disconnect();

  await cleanup(guildId);
  await interaction.editReply('Disconnected from the voice channel. Goodbye!');
}

async function cleanup(guildId: string): Promise<void> {
  const existing = activeBridges.get(guildId);
  if (!existing) return;

  activeBridges.delete(guildId);

  try {
    await existing.bridge.destroy();
    await existing.room.disconnect();
    console.log(`[bot] Cleaned up bridge for guild ${guildId}`);
  } catch (err) {
    console.error('[bot] Error during cleanup:', err);
  }
}

client.login(process.env.DISCORD_TOKEN);
