import discord
from discord.ext import commands
import os
from dotenv import load_dotenv # Import Load_dotenv to Load environment variables from .env file

#Load the .enc file
load_dotenv()

# Get the token from the .env file
TOKEN = os.getenv("DISCORD_TOKEN")


# Define the bot's intents( permissions)
intents = discord.Intents.default()
intents.message_content = True # Allows the bot to read messages

# Set up the bot with a command prefix (e.g, "!"")
bot = commands.Bot(command_prefix='!', intents=intents)

# Event that triggers when the bot is ready
@bot.event
async def on_reeady():
    print(f"Bot is logged in as {bot.user}")

# Sample command that checks if the bot is online
@bot.command(name='ping')
async def ping(ctx):
    await ctx.send("pong!")

# Run the bot with the token
bot.run(TOKEN)
