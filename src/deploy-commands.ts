import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Make the bot join your current voice channel')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Make the bot leave the voice channel')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a text message to the AI — it will reply out loud in the voice channel')
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Your message').setRequired(true),
    )
    .toJSON(),
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

(async () => {
  try {
    console.log('Registering slash commands...');
    const data = await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!),
      { body: commands },
    ) as unknown[];
    console.log(`Successfully registered ${data.length} slash commands.`);
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
